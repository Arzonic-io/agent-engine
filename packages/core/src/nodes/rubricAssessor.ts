import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  HumanMessage,
  SystemMessage,
  type AIMessage,
} from "@langchain/core/messages";
import { z } from "zod";
import type {
  Mission,
} from "../mission.js";
import type {
  RubricAssessInput,
  RubricAssessment,
  RubricAssessor,
  RubricGap,
} from "../controller.js";
import { renderRubric } from "../rubric.js";
import { billableTokens } from "../tokens.js";

/**
 * The project-level rubric assessor (the "is it good enough yet?" gate). At the
 * idle boundary — the backlog drained — this scores the WHOLE project against its
 * Definition of Done, grounded in the mission's REAL accumulated changes (the
 * injected `evidence`, e.g. the integration branch's diff), so the verdict reflects
 * shipped, re-verified code rather than item claims. `pass` is computed in code
 * (all REQUIRED criteria met AND score >= passThreshold), mirroring the critic —
 * never trusted to the model. Unmet criteria are returned as `RubricGap`s (required
 * first) so the controller can aim the next re-decompose at closing them.
 *
 * Like the decomposer/replanner, this is a `core` node whose I/O is injected: it
 * owns no git — the runtime supplies `evidence`.
 */

const SYSTEM_PROMPT = `You are the Lead reviewer of an autonomous engineering mission, judging whether
the project — as it stands RIGHT NOW — satisfies its Definition of Done (the
rubric). You are given the mission goal, its acceptance criteria, and the REAL
accumulated changes the mission has produced so far. Score every rubric criterion
by its id against that evidence. Be adversarial and grounded: judge only what the
evidence shows, never assume unseen work. A criterion is met only when the shipped
code genuinely satisfies it. For each UNMET criterion, state concretely what is
still missing so the team can close it in the next round.

LANGUAGE: Write notes in the same language as the goal — Danish if the goal is in
Danish, otherwise English. Use only Danish or English.`;

const AssessOutputSchema = z.object({
  score: z
    .number()
    .min(0)
    .max(100)
    .describe("Overall Definition-of-Done score for the project so far, 0-100."),
  criteria: z
    .array(
      z.object({
        id: z.string().describe("The rubric criterion id being judged."),
        met: z
          .boolean()
          .describe("Whether the project's current state genuinely satisfies this criterion."),
        note: z
          .string()
          .describe(
            "One sentence. For an UNMET criterion, what is concretely still missing; " +
              "for a met one, a short justification.",
          ),
      }),
    )
    .describe("One entry per rubric criterion, using the exact ids given."),
});

const MAX_EVIDENCE = 24_000;
const truncate = (s: string, n = MAX_EVIDENCE) =>
  s.length > n ? `${s.slice(0, n)}\n…(evidence truncated)` : s;

export interface MakeRubricAssessorOptions {
  /**
   * Returns a textual snapshot of the project's REAL current state — e.g. the
   * accumulated git diff of the mission's integration branch — so the verdict is
   * grounded in shipped code. Injected by the runtime; `core` owns no git. Should
   * be best-effort and not throw (the node also guards the call).
   */
  evidence: (mission: Mission) => Promise<string>;
}

export function makeRubricAssessor(
  model: BaseChatModel,
  options: MakeRubricAssessorOptions,
): RubricAssessor {
  const structured = model.withStructuredOutput(AssessOutputSchema, {
    name: "assess",
    includeRaw: true,
  });

  return {
    async assess({ mission, rubric, doneCount }: RubricAssessInput): Promise<RubricAssessment> {
      let evidence: string;
      try {
        evidence = await options.evidence(mission);
      } catch (err) {
        evidence = `(could not gather evidence: ${err instanceof Error ? err.message : String(err)})`;
      }

      const prompt = [
        `# Mission goal\n${mission.goal}`,
        mission.acceptanceCriteria.length
          ? `# Acceptance criteria\n${mission.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`
          : "",
        `# Progress\n${doneCount} item(s) reached done this run.`,
        // Operator guidance (M3 Trin 6) also steers what "good enough" means here.
        mission.guidance?.trim()
          ? `# Operator guidance (a human is steering)\n${mission.guidance.trim()}`
          : "",
        `# Definition of Done (rubric)\nScore each criterion by its id:\n${renderRubric(rubric)}`,
        `# Project's real accumulated changes so far\n${truncate(evidence).trim() || "(no changes detected)"}`,
        `# Decide\nDoes the project as it stands satisfy each criterion? Be adversarial and judge only the evidence above.`,
      ]
        .filter(Boolean)
        .join("\n\n");

      const { raw, parsed } = await structured.invoke([
        new SystemMessage(SYSTEM_PROMPT),
        new HumanMessage(prompt),
      ]);
      const output = AssessOutputSchema.parse(parsed);
      const tokens = billableTokens((raw as AIMessage).usage_metadata);

      // Deterministic pass rule — the same floor the critic enforces per item:
      // every required criterion met AND score >= threshold.
      const metById = new Map(output.criteria.map((c) => [c.id, c.met]));
      const noteById = new Map(output.criteria.map((c) => [c.id, c.note]));
      const requiredMet = rubric.criteria
        .filter((c) => c.required)
        .every((c) => metById.get(c.id) === true);
      const pass = requiredMet && output.score >= rubric.passThreshold;

      // Unmet gaps for the decomposer — REQUIRED first (they gate "done"), then
      // optional (they lift the score toward the threshold). Each carries the
      // criterion's description + the model's note on what's still missing.
      const unmet: RubricGap[] = rubric.criteria
        .filter((c) => metById.get(c.id) !== true)
        .sort((a, b) => Number(b.required) - Number(a.required))
        .map((c) => ({ id: c.id, description: c.description, note: noteById.get(c.id) }));

      const note = `rubric ${pass ? "MET" : "NOT met"} — score=${output.score}/${rubric.passThreshold}, ${unmet.length} unmet`;
      return { pass, score: output.score, unmet, note, tokensUsed: tokens };
    },
  };
}
