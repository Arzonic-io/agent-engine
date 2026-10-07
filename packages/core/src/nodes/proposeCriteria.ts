import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  HumanMessage,
  SystemMessage,
  type AIMessage,
} from "@langchain/core/messages";
import { z } from "zod";
import { defaultRubric, type RubricCriterion } from "../rubric.js";
import type { GraphStateType } from "../state.js";
import { billableTokens } from "../tokens.js";
import { withUsage } from "../usage.js";

const SYSTEM_PROMPT = `You propose EXTRA, task-specific quality criteria a reviewer should check for
THIS task — on top of the universal ones (correctness, completeness, matches the
task). Think about what "good" means for this particular deliverable:
- code → "error cases handled", "no obvious security pitfalls", "no breaking API changes"
- a plan → "milestones are dated", "risks are named"
- writing → "tone matches the audience"
Propose only what genuinely raises the bar for this task. Return 0–4 criteria;
return an EMPTY list if nothing task-specific applies. Never restate the universal
criteria. Each id is short kebab-case; each description is one falsifiable sentence.`;

const ProposeSchema = z.object({
  criteria: z
    .array(
      z.object({
        id: z.string().describe("Short kebab-case id, e.g. 'error-handling'."),
        description: z.string().describe("One falsifiable sentence the reviewer checks."),
      }),
    )
    .describe("0–4 extra, task-specific criteria. Empty if none apply."),
});

/** Ids the proposer must never shadow — the universal base criteria. */
const BASE_IDS = new Set(defaultRubric.criteria.map((c) => c.id));

const slug = (raw: string) =>
  raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

/**
 * Proposes adaptive, task-relevant criteria and writes them to `state.extraCriteria`
 * (the critic folds them in as optional). When `enabled` is false it's a pure no-op
 * — no model call, no tokens — so the graph topology can stay constant. Defensive:
 * ids are slugged + deduped, base ids and empty descriptions dropped, count capped.
 */
export function makeProposeCriteriaNode(
  model: BaseChatModel,
  opts: { enabled?: boolean; max?: number } = {},
) {
  const enabled = opts.enabled ?? false;
  const max = opts.max ?? 4;
  const structured = model.withStructuredOutput(ProposeSchema, {
    name: "extra_criteria",
    includeRaw: true,
  });

  return async (state: GraphStateType): Promise<Partial<GraphStateType>> => {
    if (!enabled) return {};

    const contextBlock = state.context ? `\n\n# Project context\n${state.context}` : "";
    const { raw, parsed } = await structured.invoke(
      [new SystemMessage(SYSTEM_PROMPT), new HumanMessage(`# Task\n${state.task}${contextBlock}`)],
      withUsage("proposeCriteria"),
    );
    const result = ProposeSchema.parse(parsed);
    const tokens = billableTokens((raw as AIMessage).usage_metadata);

    const seen = new Set<string>();
    const extraCriteria: RubricCriterion[] = [];
    for (const c of result.criteria) {
      const id = slug(c.id);
      const description = c.description.trim();
      if (!id || !description || BASE_IDS.has(id) || seen.has(id)) continue;
      seen.add(id);
      extraCriteria.push({ id, description, required: false });
      if (extraCriteria.length >= max) break;
    }

    const note =
      extraCriteria.length > 0
        ? `Adaptive kvalitetskrav for denne opgave:\n${extraCriteria
            .map((c) => `- ${c.description}`)
            .join("\n")}`
        : "Ingen opgave-specifikke ekstra-krav foreslået.";

    return {
      extraCriteria,
      tokensUsed: state.tokensUsed + tokens,
      messages: [{ agent: "system", role: "system", content: note }],
    };
  };
}
