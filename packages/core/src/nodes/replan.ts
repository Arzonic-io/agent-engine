import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  HumanMessage,
  SystemMessage,
  type AIMessage,
} from "@langchain/core/messages";
import { z } from "zod";
import type {
  ReplanDecision,
  ReplanInput,
  Replanner,
} from "../controller.js";
import type { VerifierReport } from "../verifier.js";

/**
 * Trin 5 — the Lead's replan agent. After an item runs and the Verifier reports,
 * the lead decides the item's fate and grows the backlog toward the goal:
 * close it, retry it, park it for a human, or add follow-ups (gaps, edge cases,
 * tests). It is the `Replanner` the controller loop injects — replacing
 * `defaultReplanner`. The Verifier's pass/fail stays the truth: a failing check
 * can never be marked done, enforced in code (`applyReplanGuards`), never left
 * to the model — mirroring the critic's deterministic pass rule.
 */

const SYSTEM_PROMPT = `You are the Lead of an autonomous engineering mission. One backlog item has just
been worked and verified against the real repo. Decide what happens to it and how
the backlog should grow toward the goal.

Choose itemStatus:
- "done": the deliverable satisfies the item AND the verification passed.
- "todo": worth retrying — a transient or fixable failure; the item runs again later.
- "failed": genuinely failed and not worth retrying as-is.
- "blocked_needs_human": needs a human decision or a high-risk/irreversible action
  (deploys, data deletion, payments, secrets, choosing an external provider).

Propose followUps ONLY for real, goal-relevant gaps the result exposed (missing
error handling, edge cases, validation, tests, a discovered dependency). Each is a
concrete, self-contained item — never a vague "improve" or "review". Mark a
follow-up risk:"high" if it is a deploy/delete/payment/secrets/irreversible action.
Do not duplicate items already in the backlog. Empty followUps is correct when the
item is cleanly done and nothing new surfaced.

LANGUAGE: Write reasoning and follow-up text in the same language as the goal —
Danish if the goal is in Danish, otherwise English. Use only Danish or English.`;

const FollowUpSchema = z.object({
  title: z.string().describe("Concrete, self-contained item title — imperative."),
  detail: z.string().optional().describe("One or two sentences of specifics."),
  priority: z
    .number()
    .int()
    .optional()
    .describe("Higher = sooner. Match the urgency relative to the goal."),
  risk: z
    .enum(["low", "high"])
    .optional()
    .describe("high for deploy/delete/payment/secrets/irreversible actions."),
});

const ReplanOutputSchema = z.object({
  itemStatus: z.enum(["done", "todo", "failed", "blocked_needs_human"]),
  reasoning: z.string().describe("One sentence: why this status, for the journal."),
  followUps: z
    .array(FollowUpSchema)
    .default([])
    .describe("New backlog items the result revealed are needed. Empty if none."),
});
export type ReplanOutput = z.infer<typeof ReplanOutputSchema>;

/**
 * Enforce the Verifier-is-truth rule on the model's proposal, deterministically.
 * A "done" status only survives if verification actually passed; otherwise the
 * item stays open (retry) so a failing build can never close an item.
 */
export function applyReplanGuards(
  output: ReplanOutput,
  verification: VerifierReport,
  tokensUsed: number,
): ReplanDecision {
  let itemStatus = output.itemStatus;
  if (itemStatus === "done" && !verification.passed) {
    itemStatus = "todo"; // checks failed → keep it open; thrash guard (Trin 6) bounds retries
  }
  return {
    itemStatus,
    followUps: output.followUps,
    note: output.reasoning,
    tokensUsed,
  };
}

function buildPrompt(input: ReplanInput, backlogTitles: string[]): string {
  const { mission, item, result, verification } = input;
  const checks = verification.results
    .map((r) => `- ${r.check}: ${r.passed ? "pass" : "FAIL"}`)
    .join("\n");
  const failOutput = verification.results
    .filter((r) => !r.passed)
    .map((r) => `[${r.check}]\n${r.output}`)
    .join("\n\n");
  return [
    `# Mission goal\n${mission.goal}`,
    mission.acceptanceCriteria.length
      ? `# Acceptance criteria\n${mission.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`
      : "",
    `# Item worked\n${item.title}${item.detail ? `\n${item.detail}` : ""}`,
    `# Deliverable (run status: ${result.status})\n${result.draft || "(no draft produced)"}`,
    `# Verification (passed: ${verification.passed})\n${checks}${failOutput ? `\n\nFailure output:\n${failOutput}` : ""}`,
    backlogTitles.length
      ? `# Existing backlog (do not duplicate)\n${backlogTitles.map((t) => `- ${t}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export interface MakeReplannerOptions {
  /** Titles already in the backlog, so the agent avoids proposing duplicates. */
  backlogTitles?: (input: ReplanInput) => Promise<string[]> | string[];
}

export function makeReplanner(
  model: BaseChatModel,
  options: MakeReplannerOptions = {},
): Replanner {
  const structured = model.withStructuredOutput(ReplanOutputSchema, {
    name: "replan",
    includeRaw: true,
  });

  return {
    async replan(input: ReplanInput): Promise<ReplanDecision> {
      const titles = (await options.backlogTitles?.(input)) ?? [];
      const { raw, parsed } = await structured.invoke([
        new SystemMessage(SYSTEM_PROMPT),
        new HumanMessage(buildPrompt(input, titles)),
      ]);
      const output = ReplanOutputSchema.parse(parsed);
      const tokens = (raw as AIMessage).usage_metadata?.total_tokens ?? 0;
      return applyReplanGuards(output, input.verification, tokens);
    },
  };
}
