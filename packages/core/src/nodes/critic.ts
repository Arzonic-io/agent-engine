import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  HumanMessage,
  SystemMessage,
  type AIMessage,
} from "@langchain/core/messages";
import { z } from "zod";
import { renderRubric, type Rubric } from "../rubric.js";
import type { GraphStateType, Verdict } from "../state.js";

const SYSTEM_PROMPT = `You are the Critic in a builder/critic loop. Your job is to find concrete,
actionable problems in the draft — missing requirements, factual or technical
errors, unhandled edge cases, vague hand-waving. You are NOT here to approve
work; a draft only deserves a high score when you genuinely cannot find
substantive problems. Never invent issues to seem strict, and never wave a
flawed draft through. Every issue you report must be specific enough that the
builder can act on it.`;

/** What the critic LLM must return. `pass` is computed in code from the rubric, not trusted to the model. */
const CriticOutputSchema = z.object({
  score: z
    .number()
    .min(0)
    .max(100)
    .describe("Overall quality score for the draft, 0-100."),
  criteria: z
    .array(
      z.object({
        id: z.string().describe("The rubric criterion id being judged."),
        met: z.boolean().describe("Whether the draft meets this criterion."),
        note: z.string().describe("One-sentence justification."),
      }),
    )
    .describe("One entry per rubric criterion, using the exact ids given."),
  issues: z
    .array(z.string())
    .describe(
      "Concrete, actionable problems the builder must fix. Empty only if the draft is genuinely solid.",
    ),
});

export function makeCriticNode(model: BaseChatModel, rubric: Rubric) {
  const structured = model.withStructuredOutput(CriticOutputSchema, {
    name: "verdict",
    includeRaw: true,
  });

  return async (state: GraphStateType): Promise<Partial<GraphStateType>> => {
    const prompt = [
      `# Task\n${state.task}`,
      `# Draft to evaluate (round ${state.round})\n${state.draft}`,
      `# Rubric\nJudge each criterion by its id:\n${renderRubric(rubric)}`,
    ].join("\n\n");

    const { raw, parsed } = await structured.invoke([
      new SystemMessage(SYSTEM_PROMPT),
      new HumanMessage(prompt),
    ]);

    const output = CriticOutputSchema.parse(parsed);
    const tokens = (raw as AIMessage).usage_metadata?.total_tokens ?? 0;

    // Deterministic pass rule: all required criteria met AND score >= threshold.
    const metById = new Map(output.criteria.map((c) => [c.id, c.met]));
    const requiredMet = rubric.criteria
      .filter((c) => c.required)
      .every((c) => metById.get(c.id) === true);
    const pass = requiredMet && output.score >= rubric.passThreshold;

    const verdict: Verdict = {
      pass,
      score: output.score,
      issues: output.issues,
    };

    const summary = [
      `score=${output.score} pass=${pass}`,
      ...output.criteria.map(
        (c) => `[${c.id}] ${c.met ? "met" : "NOT MET"} — ${c.note}`,
      ),
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
