/**
 * Throwaway proof of the replan agent's code-enforced guards (build-order
 * Trin 5) — the LLM proposes, but the Verifier's pass/fail is the truth. No LLM
 * call here: we test applyReplanGuards directly, the safety-critical part.
 * Run: pnpm --filter @arzonic/agent-core exec tsx verify-replan.ts
 */
import { applyReplanGuards, type ReplanOutput } from "./src/nodes/replan.js";
import type { VerifierReport } from "./src/verifier.js";

const ok = (c: boolean, m: string) => {
  if (!c) throw new Error(`FAIL: ${m}`);
  console.log(`ok: ${m}`);
};

const passed: VerifierReport = { passed: true, results: [{ passed: true, check: "test", output: "" }] };
const failed: VerifierReport = { passed: false, results: [{ passed: false, check: "test", output: "boom" }] };

// 1. Model says done + checks passed ⇒ done stands.
{
  const out: ReplanOutput = { itemStatus: "done", reasoning: "looks good", followUps: [] };
  const d = applyReplanGuards(out, passed, 42);
  ok(d.itemStatus === "done", "done survives when verification passed");
  ok(d.tokensUsed === 42, "replan tokens are surfaced for the budget");
  ok(d.note === "looks good", "reasoning carried as the journal note");
}

// 2. Model says done but checks FAILED ⇒ forced open (the critical rule).
{
  const out: ReplanOutput = { itemStatus: "done", reasoning: "I think it's fine", followUps: [] };
  const d = applyReplanGuards(out, failed, 0);
  ok(d.itemStatus === "todo", "a failing check can NEVER be marked done — forced back to todo");
}

// 3. Model parks high-risk work regardless of verification.
{
  const out: ReplanOutput = {
    itemStatus: "blocked_needs_human",
    reasoning: "needs a deploy decision",
    followUps: [{ title: "Deploy to prod", risk: "high" }],
  };
  const d = applyReplanGuards(out, passed, 5);
  ok(d.itemStatus === "blocked_needs_human", "parking decision is preserved");
  ok(d.followUps?.[0]?.risk === "high", "high-risk follow-up passes through to the backlog");
}

// 4. Follow-ups flow through unchanged.
{
  const out: ReplanOutput = {
    itemStatus: "done",
    reasoning: "done, but gaps found",
    followUps: [
      { title: "Add empty-state handling", priority: 5 },
      { title: "Add tests for checkout", detail: "cover declined cards" },
    ],
  };
  const d = applyReplanGuards(out, passed, 1);
  ok(d.followUps?.length === 2, "all proposed follow-ups carried to the decision");
}

console.log("\nReplan agent guards verified ✓");
