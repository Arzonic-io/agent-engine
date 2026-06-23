/**
 * Throwaway proof of the older task/project-graph node logic — the bits with no
 * harness yet: the critic's DETERMINISTIC rubric pass-rule (computed in code, not
 * trusted to the model), the router's single/team topology mapping, and the
 * project-memory nodes (retrieve packs context; persist writes the artifact),
 * exercised through the injected `ProjectMemory` seam. Hermetic: a scripted fake
 * model + an in-memory fake memory — no LLM, no DB. (The live pgvector round-trip
 * lives in shared/verify-memory.ts.)
 * Run: pnpm --filter @arzonic/agent-core exec tsx verify-graph-nodes.ts
 */
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";
import { makeCriticNode } from "./src/nodes/critic.js";
import { makeRouterNode } from "./src/nodes/router.js";
import { makeRetrieveContextNode } from "./src/nodes/retrieveContext.js";
import { makePersistMemoryNode } from "./src/nodes/persistMemory.js";
import { defaultRubric } from "./src/rubric.js";
import type { ProjectMemory } from "./src/memory.js";
import type { GraphStateType } from "./src/state.js";

const ok = (c: boolean, m: string) => {
  if (!c) throw new Error(`FAIL: ${m}`);
  console.log(`ok: ${m}`);
};

/** A fake structured model: every withStructuredOutput().invoke() returns the scripted parse. */
function scriptedModel(parsed: unknown, tokens = 7): BaseChatModel {
  return {
    withStructuredOutput() {
      return {
        async invoke() {
          return {
            raw: new AIMessage({
              content: "",
              usage_metadata: { input_tokens: 1, output_tokens: tokens - 1, total_tokens: tokens },
            }),
            parsed,
          };
        },
      };
    },
  } as unknown as BaseChatModel;
}

/** A minimal but complete GraphState for driving a single node. */
function state(over: Partial<GraphStateType> = {}): GraphStateType {
  return {
    task: "Write a short answer",
    messages: [],
    draft: "the draft",
    round: 1,
    verdict: null,
    status: "running",
    tokensUsed: 10,
    humanNotes: "",
    plan: [],
    currentStep: 0,
    stepResults: [],
    projectId: "",
    context: "",
    topology: "single",
    ...over,
  } as GraphStateType;
}

/** A critic model output with every required criterion met and the rest tunable. */
function criticOut(
  score: number,
  met: Partial<Record<string, boolean>> = {},
  omit: string[] = [],
) {
  const criteria = defaultRubric.criteria
    .filter((c) => !omit.includes(c.id))
    .map((c) => ({ id: c.id, met: met[c.id] ?? true, note: "" }));
  return { score, criteria, issues: [] };
}

// ── 1. Critic: the deterministic rubric pass-rule ──
{
  const run = (out: unknown) => makeCriticNode(scriptedModel(out), defaultRubric)(state());

  ok((await run(criticOut(90))).verdict!.pass === true, "all required met + score ≥ threshold ⇒ pass");
  ok(
    (await run(criticOut(100, { completeness: false }))).verdict!.pass === false,
    "a REQUIRED criterion unmet ⇒ fail, even at score 100",
  );
  ok(
    (await run(criticOut(79))).verdict!.pass === false,
    "score below passThreshold ⇒ fail, even with every required criterion met",
  );
  ok(
    (await run(criticOut(85, { "edge-cases": false, clarity: false }))).verdict!.pass === true,
    "OPTIONAL criteria never block a pass",
  );
  ok(
    (await run(criticOut(100, {}, ["matches-task"]))).verdict!.pass === false,
    "a required criterion the model OMITTED counts as not-met ⇒ fail (no passing by omission)",
  );

  const v = (await run(criticOut(90))).verdict!;
  ok(v.criteria!.length === defaultRubric.criteria.length, "one verdict criterion per rubric criterion");
  const corr = v.criteria!.find((c) => c.id === "correctness")!;
  ok(corr.required === true && corr.label === "Correctness", "verdict criterion carries required flag + prettified label");
  ok(v.score === 90, "the model's score is surfaced on the verdict");

  const folded = await run(criticOut(90));
  ok(folded.tokensUsed === 10 + 7, "critic folds its token usage into the running total");
}

// ── 2. Router: single/team topology mapping ──
{
  const single = await makeRouterNode(scriptedModel({ topology: "single", reason: "small fix" }))(
    state({ tokensUsed: 5 }),
  );
  ok(single.topology === "single", "router maps a 'single' decision to topology single");
  ok(single.status === "running", "router sets status running");
  ok(single.tokensUsed === 5 + 7, "router folds its tokens");
  ok(!!single.messages?.[0]?.content.includes("single"), "router records its choice + reason in a system message");

  const team = await makeRouterNode(scriptedModel({ topology: "team", reason: "multi-part plan" }))(state());
  ok(team.topology === "team", "router maps a 'team' decision to topology team");
}

// ── 3. Project-memory nodes via the injected ProjectMemory seam ──
function fakeMemory() {
  const stored: { kind: string; content: string }[] = [];
  const retrieveCalls: { projectId: string; query: string }[] = [];
  const mem: ProjectMemory = {
    async retrieve(projectId, query) {
      retrieveCalls.push({ projectId, query });
      return {
        brief: "Relaunch the Ranky front page for higher conversion.",
        hits: [{ kind: "decision", content: "Launch date is March 15.", score: 0.91 }],
      };
    },
    async store(_projectId, kind, content) {
      stored.push({ kind, content });
    },
  };
  return { mem, stored, retrieveCalls };
}

{
  // retrieveContext: with a project, pulls brief + hits into context.
  const f = fakeMemory();
  const got = await makeRetrieveContextNode(f.mem)(state({ projectId: "p1", task: "When do we launch?" }));
  ok(f.retrieveCalls[0]?.query === "When do we launch?", "retrieve is queried with the task");
  ok(got.context!.includes("Project brief") && got.context!.includes("Relaunch"), "context packs the project brief");
  ok(got.context!.includes("Launch date is March 15"), "context packs the retrieved memory hit");
  ok(got.status === "running", "retrieve sets status running");
  ok((got.messages?.length ?? 0) > 0, "retrieve emits a system note when context was found");

  // retrieveContext: a scratch task (no project) skips retrieval entirely.
  const f2 = fakeMemory();
  const scratch = await makeRetrieveContextNode(f2.mem)(state({ projectId: "" }));
  ok(scratch.context === "" && f2.retrieveCalls.length === 0, "no projectId ⇒ no retrieve, empty context");

  // persistMemory: an accepted draft is written back as an artifact.
  const f3 = fakeMemory();
  const persisted = await makePersistMemoryNode(f3.mem)(state({ projectId: "p1", draft: "The final plan." }));
  ok(
    f3.stored.length === 1 && f3.stored[0]!.kind === "artifact" && f3.stored[0]!.content === "The final plan.",
    "persist stores the accepted draft as an artifact",
  );
  ok((persisted.messages?.length ?? 0) > 0, "persist emits a system note");

  // persistMemory guards: no project, or an empty draft ⇒ nothing written.
  const f4 = fakeMemory();
  await makePersistMemoryNode(f4.mem)(state({ projectId: "", draft: "x" }));
  ok(f4.stored.length === 0, "no projectId ⇒ nothing persisted");
  const f5 = fakeMemory();
  await makePersistMemoryNode(f5.mem)(state({ projectId: "p1", draft: "   " }));
  ok(f5.stored.length === 0, "empty draft ⇒ nothing persisted");

  // persistMemory is best-effort: a write error never fails an accepted run.
  const throwing: ProjectMemory = {
    async retrieve() {
      return { brief: "", hits: [] };
    },
    async store() {
      throw new Error("db down");
    },
  };
  let threw = false;
  try {
    await makePersistMemoryNode(throwing)(state({ projectId: "p1", draft: "x" }));
  } catch {
    threw = true;
  }
  ok(!threw, "a persistence write error is swallowed — an accepted run never fails on it");
}

console.log("\nTask/project graph nodes (rubric pass-rule, router, memory) verified ✓");
