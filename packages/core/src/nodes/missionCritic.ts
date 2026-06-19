import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage, type AIMessage } from "@langchain/core/messages";
import { z } from "zod";
import type { GraphStateType, Verdict } from "../state.js";
import type { WritableRepoTools } from "../tools.js";

const SYSTEM_PROMPT = `You are the mission Critic — an adversarial code reviewer on an autonomous
mission team. The Implementer just wrote code in a git worktree to satisfy ONE
backlog item. Your job is to CHALLENGE that work: read the actual diff and decide
whether it correctly and completely satisfies the item and its acceptance
criteria. Hunt for "green-but-wrong" — code that may compile or pass shallow
checks but misimplements the intent, ignores an acceptance criterion, handles only
the happy path, or leaves an obvious edge case unhandled. You are NOT here to
approve: set pass=true only when you genuinely cannot find a substantive problem.
Every issue must be ONE concrete, actionable sentence the Implementer can fix.

LANGUAGE: Write issues in the same language as the item (Danish if it is Danish,
otherwise English).`;

/** What the reviewer returns. The graph loops back to the implementer on pass=false. */
const MissionReviewSchema = z.object({
  pass: z
    .boolean()
    .describe("True ONLY if the change correctly AND completely satisfies the item — no substantive problems."),
  issues: z
    .array(z.string())
    .describe(
      "Concrete, actionable problems the implementer must fix — one self-contained sentence each, " +
        "plain text. Empty only when pass is true.",
    ),
});

const MAX_DIFF = 16_000;
const truncate = (s: string, n = MAX_DIFF) =>
  s.length > n ? `${s.slice(0, n)}\n…(diff truncated)` : s;

/**
 * Mission reviewer node (M3 ★ — the team challenges each item in a mission). After
 * the Implementer writes code in a worktree, this critic reviews the ACTUAL change
 * (`git diff`, captured in code — NOT via an LLM tool, so no write capability is
 * exposed to it) against the item's acceptance criteria and returns pass/fail +
 * issues. On fail the graph loops back to the Implementer with the issues as
 * guidance. Grounded: it judges the real diff, not the implementer's own summary.
 * The Verifier (real checks) still independently decides "done" afterwards — the
 * critic is an EXTRA gate that catches green-but-wrong work the checks would miss.
 */
export function makeMissionCriticNode(model: BaseChatModel, repo: WritableRepoTools) {
  const structured = model.withStructuredOutput(MissionReviewSchema, {
    name: "review",
    includeRaw: true,
  });

  return async (state: GraphStateType): Promise<Partial<GraphStateType>> => {
    let diff: string;
    try {
      // Intent-to-add surfaces NEW files in the diff without staging their content;
      // the worktree has its own index, so this never touches the main repo.
      await repo.runCommand("git", ["add", "-A", "-N"]);
      diff = await repo.runCommand("git", ["--no-pager", "diff"]);
    } catch (err) {
      diff = `(could not compute diff: ${err instanceof Error ? err.message : String(err)})`;
    }

    const prompt = [
      `# Backlog item\n${state.task}`,
      `# Implementer's own summary\n${state.draft || "(none)"}`,
      `# Actual changes (git diff)\n${truncate(diff).trim() || "(no changes detected)"}`,
      `# Decide\nDoes this change correctly and completely satisfy the item and its acceptance criteria? Be adversarial. Set pass=true only if you cannot find a substantive problem; otherwise list concrete issues for the implementer to fix.`,
    ].join("\n\n");

    const { raw, parsed } = await structured.invoke([
      new SystemMessage(SYSTEM_PROMPT),
      new HumanMessage(prompt),
    ]);
    const review = MissionReviewSchema.parse(parsed);
    const tokens = (raw as AIMessage).usage_metadata?.total_tokens ?? 0;

    const verdict: Verdict = {
      pass: review.pass,
      score: review.pass ? 100 : 0,
      issues: review.issues,
    };

    const summary = review.pass
      ? "review: pass — no substantive problems found"
      : `review: FAIL\n${review.issues.map((i) => `- ${i}`).join("\n")}`;

    return {
      verdict,
      tokensUsed: state.tokensUsed + tokens,
      messages: [{ agent: "critic", role: "assistant", content: summary }],
    };
  };
}
