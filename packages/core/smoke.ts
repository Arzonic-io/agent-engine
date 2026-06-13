/**
 * Throwaway smoke test for graph wiring — runs with a stub model, no API keys.
 * Not part of the build (outside src/). Run: pnpm --filter @arzonic/agent-core exec tsx smoke.ts
 */
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";
import { Command, MemorySaver } from "@langchain/langgraph";
import { createAgentGraph, type GraphStateType } from "./src/index.js";

function stubModel(passOnCall: number): BaseChatModel {
  let buildCalls = 0;
  let criticCalls = 0;
  const stub = {
    invoke: async () => {
      buildCalls++;
      return new AIMessage({
        content: `draft v${buildCalls}`,
        usage_metadata: { input_tokens: 50, output_tokens: 50, total_tokens: 100 },
      });
    },
    withStructuredOutput: () => ({
      invoke: async () => {
        criticCalls++;
        const pass = criticCalls >= passOnCall;
        return {
          raw: new AIMessage({
            content: "",
            usage_metadata: { input_tokens: 30, output_tokens: 30, total_tokens: 60 },
          }),
          parsed: {
            score: pass ? 95 : 40,
            criteria: [
              { id: "correctness", met: pass, note: "stub" },
              { id: "completeness", met: pass, note: "stub" },
              { id: "matches-task", met: true, note: "stub" },
              { id: "edge-cases", met: pass, note: "stub" },
              { id: "clarity", met: true, note: "stub" },
            ],
            issues: pass ? [] : [`fix something (round ${criticCalls})`],
          },
        };
      },
    }),
  };
  return stub as unknown as BaseChatModel;
}

const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`ok: ${msg}`);
};

async function drain(stream: AsyncIterable<unknown>) {
  const updates: Record<string, unknown>[] = [];
  for await (const u of stream) updates.push(u as Record<string, unknown>);
  return updates;
}

const interruptOf = (updates: Record<string, unknown>[]) =>
  updates.find((u) => "__interrupt__" in u);

// Scenario A: critic never passes -> terminates at MAX_ROUNDS, gate fires, reject -> failed
{
  const saver = new MemorySaver();
  const graph = createAgentGraph({
    model: stubModel(999),
    checkpointer: saver,
    guardrails: { maxRounds: 3 },
  });
  const cfg = { configurable: { thread_id: "A" } };
  const updates = await drain(await graph.stream({ task: "t", status: "running" }, { ...cfg, streamMode: "updates" }));
  assert(interruptOf(updates) !== undefined, "A: human gate interrupt fired");
  let s = (await graph.getState(cfg)).values as GraphStateType;
  assert(s.round === 3, `A: terminated at MAX_ROUNDS (round=${s.round})`);
  assert(s.status === "awaiting_human", "A: status awaiting_human while paused");
  await drain(await graph.stream(new Command({ resume: "reject" }) as never, { ...cfg, streamMode: "updates" }));
  s = (await graph.getState(cfg)).values as GraphStateType;
  assert(s.status === "failed", "A: reject -> failed");
}

// Scenario B: critic passes on call 2 -> gate after round 2, approve -> accepted.
// Resume happens through a NEW graph instance over the same checkpointer (resume wiring).
{
  const saver = new MemorySaver();
  const make = () =>
    createAgentGraph({ model: stubModel(2), checkpointer: saver, guardrails: { maxRounds: 5 } });
  const cfg = { configurable: { thread_id: "B" } };
  const g1 = make();
  await drain(await g1.stream({ task: "t", status: "running" }, { ...cfg, streamMode: "updates" }));
  let s = (await g1.getState(cfg)).values as GraphStateType;
  assert(s.round === 2 && s.verdict?.pass === true, `B: rubric pass on round 2 (round=${s.round})`);
  const g2 = make();
  const pending = (await g2.getState(cfg)).tasks.flatMap((t) => t.interrupts ?? []);
  assert(pending.length === 1, "B: pending interrupt visible from new graph instance");
  await drain(await g2.stream(new Command({ resume: "approve" }) as never, { ...cfg, streamMode: "updates" }));
  s = (await g2.getState(cfg)).values as GraphStateType;
  assert(s.status === "accepted", "B: approve via resumed instance -> accepted");
  assert(s.messages.length >= 5, `B: transcript populated (${s.messages.length} messages)`);
}

// Scenario C: tiny token budget -> fail node, status failed, no infinite loop
{
  const graph = createAgentGraph({
    model: stubModel(999),
    checkpointer: new MemorySaver(),
    guardrails: { maxRounds: 10, tokenBudget: 150 },
  });
  const cfg = { configurable: { thread_id: "C" } };
  await drain(await graph.stream({ task: "t", status: "running" }, { ...cfg, streamMode: "updates" }));
  const s = (await graph.getState(cfg)).values as GraphStateType;
  assert(s.status === "failed", "C: token budget exceeded -> failed");
  assert(s.tokensUsed > 150, `C: tokens tracked (${s.tokensUsed})`);
}

console.log("\nAll smoke scenarios passed.");
