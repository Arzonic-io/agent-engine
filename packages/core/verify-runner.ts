/**
 * Throwaway proof of the WorkRunner graph adapter (build-order Trin 3) with a
 * fake compiled graph — no LLM, no checkpointer. Proves: the item runs under
 * thread_id = item.id, the task is built from context+title+detail, the human
 * gate is auto-cleared (missions never block), and the final draft/verdict/
 * status are read back as the deliverable.
 * Run: pnpm --filter @arzonic/agent-core exec tsx verify-runner.ts
 */
import { Command } from "@langchain/langgraph";
import { createGraphWorkRunner, type RunnableMissionGraph } from "./src/runner.js";

const ok = (c: boolean, m: string) => {
  if (!c) throw new Error(`FAIL: ${m}`);
  console.log(`ok: ${m}`);
};

/**
 * A fake graph that records calls and simulates one human-gate interrupt before
 * terminating. Mirrors the real compiled-graph surface the adapter relies on.
 */
function makeFakeGraph() {
  const calls: { threadId: unknown; isResume: boolean; task?: string }[] = [];
  let interruptCleared = false;
  let draft = "";

  const graph: RunnableMissionGraph = {
    async invoke(input, config) {
      const threadId = (config as { configurable?: { thread_id?: unknown } })?.configurable
        ?.thread_id;
      const isResume = input instanceof Command;
      if (isResume) {
        interruptCleared = true; // gate approved → run can terminate
      } else {
        draft = `delivered: ${(input as { task?: string }).task}`;
      }
      calls.push({
        threadId,
        isResume,
        task: isResume ? undefined : (input as { task?: string }).task,
      });
      return {};
    },
    async getState() {
      // Pause at the gate exactly once, then report terminal.
      const interrupted = !interruptCleared;
      return {
        values: {
          status: interruptCleared ? "accepted" : "awaiting_human",
          draft,
          verdict: { pass: true, score: 90, issues: [] },
          tokensUsed: 1234,
        },
        tasks: interrupted ? [{ interrupts: [{ value: "gate" }] }] : [{ interrupts: [] }],
      };
    },
  };
  return { graph, calls: () => calls };
}

const { graph, calls } = makeFakeGraph();
const runner = createGraphWorkRunner(graph, { baseInput: { projectId: "proj-1" } });

const result = await runner.run({
  id: "item-42",
  title: "Add a health endpoint",
  detail: "GET /health returns 200.",
  context: "Mission goal: ship the API.",
});

const log = calls();
ok(log[0]!.threadId === "item-42", "ran under thread_id = item.id (checkpointed by item id)");
ok(
  log[0]!.task === "Mission goal: ship the API.\n\nAdd a health endpoint\n\nGET /health returns 200.",
  "task built from context + title + detail",
);
ok(log.some((c) => c.isResume), "auto-cleared the human gate (mission never blocks)");
ok(result.runId === "item-42", "result.runId equals the item id");
ok(result.status === "accepted", "final status read from the terminal checkpoint");
ok(result.draft === "delivered: Mission goal: ship the API.\n\nAdd a health endpoint\n\nGET /health returns 200.", "deliverable is the graph's final draft");
ok(result.verdict?.pass === true && result.tokensUsed === 1234, "verdict + tokensUsed surfaced");

// A graph that never interrupts should not loop or resume.
const { graph: clean, calls: cleanCalls } = (() => {
  const c: { isResume: boolean }[] = [];
  const g: RunnableMissionGraph = {
    async invoke(input) {
      c.push({ isResume: input instanceof Command });
      return {};
    },
    async getState() {
      return {
        values: { status: "accepted", draft: "d", verdict: null, tokensUsed: 1 },
        tasks: [{ interrupts: [] }],
      };
    },
  };
  return { graph: g, calls: () => c };
})();
await createGraphWorkRunner(clean).run({ id: "x", title: "t" });
ok(!cleanCalls().some((c) => c.isResume), "no gate interrupt ⇒ no resume call (no busy loop)");

console.log("\nWorkRunner graph adapter verified ✓");
