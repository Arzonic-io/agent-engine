/**
 * Throwaway proof of the human gate's reject-and-revise loop — the decision that
 * turns "Revise with notes" in the UI into another builder round. Drives the real
 * compiled project graph through interrupt → resume(Command) with a scripted fake
 * model + fake memory (no LLM, no DB), proving:
 *   - `revise` + notes loops BACK to the builder, and the notes reach the builder's
 *     prompt as "# Human guidance" (the whole point — a rejection must steer the redo);
 *   - the run pauses at the gate AGAIN, so a human can keep steering;
 *   - `approve` persists the accepted draft to project memory; `revise`/`reject` do NOT;
 *   - a bare-string decision (the CLI form of HumanResume) still drives the loop.
 * Complements smoke.ts (approve/reject only) — the `revise` edge had no harness.
 * Run: pnpm --filter @arzonic/agent-core exec tsx verify-gate.ts
 */
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import { AIMessage } from "@langchain/core/messages";
import { Command, MemorySaver } from "@langchain/langgraph";
import { createProjectGraph } from "./src/graph.js";
import { defaultRubric } from "./src/rubric.js";
import type { ProjectMemory } from "./src/memory.js";
import type { GraphStateType } from "./src/state.js";

const ok = (c: boolean, m: string) => {
  if (!c) throw new Error(`FAIL: ${m}`);
  console.log(`ok: ${m}`);
};

const usage = { input_tokens: 10, output_tokens: 10, total_tokens: 20 };

/** A verdict that passes the deterministic rubric (every required criterion met). */
const passVerdict = () => ({
  score: 95,
  criteria: defaultRubric.criteria.map((c) => ({ id: c.id, met: true, note: "" })),
  issues: [] as string[],
});

/**
 * A fake model for the project graph: the builder path (`invoke` → `_generate`)
 * records every prompt it was handed and returns a numbered draft; the router and
 * critic paths (`withStructuredOutput`) are told apart by their schema shape. The
 * critic always passes so we reach the gate on round 1 and the loop is driven purely
 * by the human decision.
 */
class FakeGateModel extends BaseChatModel {
  readonly builderPrompts: BaseMessage[][] = [];
  constructor(private readonly topology: "single" | "team" = "single") {
    super({});
  }
  _llmType() {
    return "fake-gate";
  }
  override bindTools() {
    return this;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override withStructuredOutput(schema: any): any {
    const keys = Object.keys(schema?.shape ?? {});
    const isRouter = keys.includes("topology");
    return {
      invoke: async () => ({
        raw: new AIMessage({ content: "", usage_metadata: usage }),
        parsed: isRouter ? { topology: this.topology, reason: "test route" } : passVerdict(),
      }),
    };
  }
  async _generate(messages: BaseMessage[]) {
    this.builderPrompts.push(messages);
    const n = this.builderPrompts.length;
    const draft = `draft v${n}`;
    return {
      generations: [{ text: draft, message: new AIMessage({ content: draft, usage_metadata: usage }) }],
    };
  }
}

/** A project memory that records every store() so we can prove persist-on-approve-only. */
function fakeMemory() {
  const stored: { kind: string; content: string }[] = [];
  const mem: ProjectMemory = {
    async retrieve() {
      return { brief: "", hits: [] };
    },
    async store(_projectId, kind, content) {
      stored.push({ kind, content });
    },
  };
  return { mem, stored };
}

const seed = (): Partial<GraphStateType> => ({ task: "Skriv et svar", status: "running", projectId: "p1" });

async function drain(stream: AsyncIterable<unknown>) {
  const updates: Record<string, unknown>[] = [];
  for await (const u of stream) updates.push(u as Record<string, unknown>);
  return updates;
}
const hitGate = (updates: Record<string, unknown>[]) => updates.some((u) => "__interrupt__" in u);

// ── 1. revise + notes → back to the builder (with the notes), pause at the gate again, then approve ──
{
  const model = new FakeGateModel("single");
  const { mem, stored } = fakeMemory();
  const graph = createProjectGraph({
    model: model as unknown as BaseChatModel,
    memory: mem,
    checkpointer: new MemorySaver(),
    guardrails: { maxRounds: 5 },
  });
  const cfg = { configurable: { thread_id: "revise" } };

  const first = await drain(await graph.stream(seed(), { ...cfg, streamMode: "updates" }));
  ok(hitGate(first), "reaches the human gate on round 1 (critic passed)");
  let s = (await graph.getState(cfg)).values as GraphStateType;
  ok(s.status === "awaiting_human" && s.round === 1, "paused awaiting_human after one builder round");
  ok(stored.length === 0, "nothing persisted while merely awaiting a decision");

  const notes = "tilføj fejlhåndtering for tom input";
  const second = await drain(
    await graph.stream(new Command({ resume: { decision: "revise", notes } }) as never, {
      ...cfg,
      streamMode: "updates",
    }),
  );
  s = (await graph.getState(cfg)).values as GraphStateType;
  ok(s.round === 2, "revise ran the builder a SECOND time (looped back, not ended)");
  ok(model.builderPrompts.length === 2, "the builder node was actually invoked again");
  ok(
    JSON.stringify(model.builderPrompts[1]).includes(notes),
    "the human's revise notes reached the builder's prompt (the redo is steered)",
  );
  ok(hitGate(second), "the revised round pauses at the gate again — the human keeps control");
  ok(stored.length === 0, "revise persists nothing — only an approval commits an artifact");

  await drain(
    await graph.stream(new Command({ resume: "approve" }) as never, { ...cfg, streamMode: "updates" }),
  );
  s = (await graph.getState(cfg)).values as GraphStateType;
  ok(s.status === "accepted", "approve after the revision → accepted");
  ok(
    stored.length === 1 && stored[0]!.kind === "artifact" && stored[0]!.content === "draft v2",
    "the FINAL (revised) draft is what gets persisted, exactly once",
  );
}

// ── 2. reject → failed, nothing persisted ──
{
  const model = new FakeGateModel("single");
  const { mem, stored } = fakeMemory();
  const graph = createProjectGraph({
    model: model as unknown as BaseChatModel,
    memory: mem,
    checkpointer: new MemorySaver(),
    guardrails: { maxRounds: 5 },
  });
  const cfg = { configurable: { thread_id: "reject" } };

  await drain(await graph.stream(seed(), { ...cfg, streamMode: "updates" }));
  await drain(
    await graph.stream(new Command({ resume: { decision: "reject", notes: "ikke godt nok" } }) as never, {
      ...cfg,
      streamMode: "updates",
    }),
  );
  const s = (await graph.getState(cfg)).values as GraphStateType;
  ok(s.status === "failed", "reject → failed");
  ok(stored.length === 0, "a rejected draft is never persisted to project memory");
}

// ── 3. bare-string decisions (the CLI HumanResume form) still drive the loop ──
{
  const model = new FakeGateModel("single");
  const { mem } = fakeMemory();
  const graph = createProjectGraph({
    model: model as unknown as BaseChatModel,
    memory: mem,
    checkpointer: new MemorySaver(),
    guardrails: { maxRounds: 5 },
  });
  const cfg = { configurable: { thread_id: "cli" } };

  await drain(await graph.stream(seed(), { ...cfg, streamMode: "updates" }));
  const again = await drain(
    await graph.stream(new Command({ resume: "revise" }) as never, { ...cfg, streamMode: "updates" }),
  );
  let s = (await graph.getState(cfg)).values as GraphStateType;
  ok(s.round === 2 && hitGate(again), "bare 'revise' string loops back to the builder and re-gates");
  await drain(await graph.stream(new Command({ resume: "approve" }) as never, { ...cfg, streamMode: "updates" }));
  s = (await graph.getState(cfg)).values as GraphStateType;
  ok(s.status === "accepted", "bare 'approve' string accepts — string HumanResume back-compat holds");
}

console.log("\nHuman gate reject-and-revise loop verified ✓");
