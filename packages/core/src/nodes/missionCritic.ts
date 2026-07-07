import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage, type AIMessage } from "@langchain/core/messages";
import { z } from "zod";
import { augmentRubric, renderRubric, type Rubric } from "../rubric.js";
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

const RUBRIC_SYSTEM_PROMPT = `You are the mission Critic — an adversarial code reviewer on an autonomous
mission team. The Implementer just wrote code in a git worktree to satisfy ONE
backlog item. Your job is to CHALLENGE that work against the project's Definition
of Done (the rubric): read the ACTUAL diff and score every rubric criterion by its
id. Hunt for "green-but-wrong" — code that may compile or pass shallow checks but
misimplements the intent, ignores an acceptance criterion, handles only the happy
path, or leaves an obvious edge case unhandled. Judge only what the diff shows; do
not assume unseen code. Never wave a flawed change through, and never invent
problems to seem strict. Every issue must be ONE concrete, actionable sentence the
Implementer can fix.

LANGUAGE: Write issues in the same language as the item (Danish if it is Danish,
otherwise English). Use only Danish or English.`;

/** Binary reviewer output — used when no rubric is configured (pre-rubric behaviour). */
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

/** Per-criterion reviewer output — used when a rubric is configured. `pass` is
 *  computed in code from the rubric floor, not trusted to the model. */
const RubricReviewSchema = z.object({
  score: z
    .number()
    .min(0)
    .max(100)
    .describe("Overall quality score for the change, 0-100."),
  criteria: z
    .array(
      z.object({
        id: z.string().describe("The rubric criterion id being judged."),
        met: z.boolean().describe("Whether the diff meets this criterion."),
        note: z.string().describe("One-sentence justification, grounded in the diff."),
      }),
    )
    .describe("One entry per rubric criterion, using the exact ids given."),
  issues: z
    .array(z.string())
    .describe(
      "Concrete, actionable problems the implementer must fix — one self-contained sentence " +
        "each, plain text. Empty only if the change is genuinely solid.",
    ),
});

const MAX_DIFF = 16_000;
const truncate = (s: string, n = MAX_DIFF) =>
  s.length > n ? `${s.slice(0, n)}\n…(diff truncated)` : s;

const prettify = (id: string) =>
  id.replace(/[-_]/g, " ").replace(/^\w/, (c) => c.toUpperCase());

/**
 * Mission reviewer node (M3 ★ — the team challenges each item in a mission). After
 * the Implementer writes code in a worktree, this critic reviews the ACTUAL change
 * (`git diff`, captured in code — NOT via an LLM tool, so no write capability is
 * exposed to it) and returns pass/fail + issues. On fail the graph loops back to
 * the Implementer with the issues as guidance. Grounded: it judges the real diff,
 * not the implementer's own summary. The Verifier (real checks) still independently
 * decides "done" afterwards — the critic is an EXTRA gate that catches
 * green-but-wrong work the checks would miss.
 *
 * When a `rubric` is supplied (the project's floor-enforced Definition of Done),
 * the critic scores the diff PER CRITERION and `pass` is computed in code —
 * every REQUIRED criterion met AND score >= passThreshold — so the mission's
 * per-item gate enforces the same quality bar the operator configured, not a
 * freeform binary judgement. Omit the rubric for the pre-rubric binary behaviour.
 */
export function makeMissionCriticNode(
  model: BaseChatModel,
  repo: WritableRepoTools,
  rubric?: Rubric,
) {
  const structuredBinary = model.withStructuredOutput(MissionReviewSchema, {
    name: "review",
    includeRaw: true,
  });
  const structuredRubric = model.withStructuredOutput(RubricReviewSchema, {
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
    const diffBlock = truncate(diff).trim() || "(no changes detected)";

    if (!rubric) {
      const prompt = [
        `# Backlog item\n${state.task}`,
        `# Implementer's own summary\n${state.draft || "(none)"}`,
        `# Actual changes (git diff)\n${diffBlock}`,
        `# Decide\nDoes this change correctly and completely satisfy the item and its acceptance criteria? Be adversarial. Set pass=true only if you cannot find a substantive problem; otherwise list concrete issues for the implementer to fix.`,
      ].join("\n\n");

      const { raw, parsed } = await structuredBinary.invoke([
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
    }

    // Rubric path: fold in this run's adaptive criteria (optional-only) so a
    // proposed, task-relevant check is scored alongside the project rubric.
    const effective = augmentRubric(rubric, state.extraCriteria ?? []);
    const prompt = [
      `# Backlog item\n${state.task}`,
      `# Implementer's own summary\n${state.draft || "(none)"}`,
      `# Actual changes (git diff)\n${diffBlock}`,
      `# Rubric (Definition of Done)\nJudge each criterion by its id against the diff:\n${renderRubric(effective)}`,
    ].join("\n\n");

    const { raw, parsed } = await structuredRubric.invoke([
      new SystemMessage(RUBRIC_SYSTEM_PROMPT),
      new HumanMessage(prompt),
    ]);
    const output = RubricReviewSchema.parse(parsed);
    const tokens = (raw as AIMessage).usage_metadata?.total_tokens ?? 0;

    // Deterministic pass rule: all required criteria met AND score >= threshold —
    // the same floor the interactive critic enforces.
    const metById = new Map(output.criteria.map((c) => [c.id, c.met]));
    const requiredMet = effective.criteria
      .filter((c) => c.required)
      .every((c) => metById.get(c.id) === true);
    const pass = requiredMet && output.score >= effective.passThreshold;

    const verdict: Verdict = {
      pass,
      score: output.score,
      issues: output.issues,
      criteria: effective.criteria.map((c) => ({
        id: c.id,
        label: prettify(c.id),
        met: metById.get(c.id) === true,
        required: c.required,
      })),
    };

    const summary = [
      `review: score=${output.score} pass=${pass}`,
      ...output.criteria.map((c) => `[${c.id}] ${c.met ? "met" : "NOT MET"} — ${c.note}`),
      ...(output.issues.length > 0
        ? ["issues:", ...output.issues.map((i) => `- ${i}`)]
        : ["no issues"]),
    ].join("\n");

    return {
      verdict,
      tokensUsed: state.tokensUsed + tokens,
      messages: [{ agent: "critic", role: "assistant", content: summary }],
    };
  };
}
