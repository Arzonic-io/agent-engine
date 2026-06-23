/**
 * Throwaway proof of the replan agent's code-enforced guards (build-order
 * Trin 5) — the LLM proposes, but the Verifier's pass/fail is the truth. No LLM
 * call here: we test applyReplanGuards directly, the safety-critical part.
 * Run: pnpm --filter @arzonic/agent-core exec tsx verify-replan.ts
 */
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { applyReplanGuards, makeReplanner, type ReplanOutput } from "./src/nodes/replan.js";
import type { ReplanInput } from "./src/controller.js";
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

// ── 5. guidance (Trin 6): operator course-correction reaches the replan prompt ──
{
  let captured: BaseMessage[] = [];
  // A fake model that records the prompt it's asked to complete, then returns a
  // canned "done" decision so makeReplanner runs end-to-end without a real LLM.
  const fakeModel = {
    withStructuredOutput() {
      return {
        async invoke(messages: BaseMessage[]) {
          captured = messages;
          return {
            raw: new AIMessage({
              content: "",
              usage_metadata: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            }),
            parsed: { itemStatus: "done", reasoning: "ok", followUps: [] } as ReplanOutput,
          };
        },
      };
    },
  } as unknown as BaseChatModel;

  const input = (guidance: string | null): ReplanInput => ({
    mission: {
      id: "m", projectId: "p", goal: "Build X", acceptanceCriteria: [], repoPath: "/r",
      status: "running", budget: null, spentTokens: 0, deadline: null, roleModels: {}, guidance,
      createdAt: "t",
    },
    item: {
      id: "i", missionId: "m", title: "do i", detail: "", status: "in_progress", priority: 0,
      dependsOn: [], risk: "low", runId: null, verification: null, diff: null, createdAt: "t", updatedAt: "t",
    },
    result: { runId: "i", status: "accepted", draft: "built", verdict: null, tokensUsed: 0 },
    verification: { passed: true, results: [{ passed: true, check: "test", output: "" }] },
  });

  const replanner = makeReplanner(fakeModel);
  const promptText = () => {
    const human = captured[1]!; // [SystemMessage, HumanMessage]
    return typeof human.content === "string" ? human.content : JSON.stringify(human.content);
  };

  await replanner.replan(input("Prioritér fejlhåndtering frem for nye features"));
  ok(promptText().includes("Operator guidance"), "guidance adds an Operator-guidance section to the replan prompt");
  ok(promptText().includes("Prioritér fejlhåndtering"), "the human's guidance text is carried verbatim into the prompt");

  await replanner.replan(input(null));
  ok(!promptText().includes("Operator guidance"), "no guidance ⇒ no guidance section (back-compat)");
}

console.log("\nReplan agent guards verified ✓");
