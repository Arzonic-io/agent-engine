import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  HumanMessage,
  SystemMessage,
  type AIMessage,
} from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import { DEFAULT_LLM_CALL_TIMEOUT_MS, withLlmTimeout } from "../llmCallTimeout.js";
import { formatPlanStep, PlanStepSchema, type GraphStateType } from "../state.js";
import type { RepoTools } from "../tools.js";
import { surveyRepo } from "./repoSurvey.js";
import { billableTokens } from "../tokens.js";
import { withUsage } from "../usage.js";

/**
 * Two prompts, because the Architect has two jobs depending on what it was given.
 *
 * Without a repo it plans from the task text alone — the original behaviour, and
 * still the right one for non-code tasks (a brief, a document) where there is no
 * repo to survey.
 *
 * With a repo it has already surveyed the code, and the plan it writes is a
 * HANDOFF: the whole point of splitting architect and worker across models is
 * that the expensive model decides and the cheap one executes. That only pays if
 * the plan carries the decisions. A step that just says "add offset/limit to
 * read_file" forces the worker to re-derive every file and call site the
 * architect already found — you pay twice and get the weaker answer.
 */
const BASE_PROMPT = `You are the Architect of a small agent team. Break the task into a short,
ordered plan of 3-6 concrete, self-contained steps that, done in order, fully
deliver the task. Each step's title is one imperative sentence describing a
tangible piece of the work — no meta-steps like "review" or "plan". Order
matters: earlier steps produce what later steps build on.`;

const GROUNDED_PROMPT = `

A survey of the actual codebase is provided below. Your plan is a HANDOFF: it
will be executed by a worker that is cheaper and less capable than you, and that
CANNOT see your reasoning. Decide the things worth deciding, and write them down.

For every step, on top of the title:
- "files": the exact paths it touches. Take them from the survey — do not invent
  a path, and do not guess at one you could not confirm.
- "change": what to actually do there. The approach and the specifics, not a
  reworded title.
- "verify": the concrete check that proves it. Prefer a check the survey confirmed
  exists; do not name one you have not seen.
- "done": the observable condition that ends the step.

Leave a field out rather than filling it with a guess — an empty field costs the
worker one look, a wrong one costs it the whole step.`;

const LANGUAGE_RULE = `

LANGUAGE: Write the steps in the same language as the task — Danish if the task
is in Danish, otherwise English. Use only Danish or English.`;

const PlanSchema = z.object({
  plan: z
    .array(PlanStepSchema)
    .min(1)
    .max(8)
    .describe("Ordered list of concrete steps, each a title plus what the worker needs to execute it."),
});

export interface MakeArchitectOptions {
  /**
   * Read-only repo access. When present the Architect SURVEYS the code before
   * planning, so its steps can name real files and real checks. Omit for
   * non-code tasks — the node then plans from the task text, exactly as before.
   */
  repo?: RepoTools;
  llmCallTimeoutMs?: number;
}

export function makeArchitectNode(
  model: BaseChatModel,
  options: MakeArchitectOptions | number = {},
) {
  // A bare number is the old (model, llmCallTimeoutMs) signature.
  const opts: MakeArchitectOptions =
    typeof options === "number" ? { llmCallTimeoutMs: options } : options;
  const llmCallTimeoutMs = opts.llmCallTimeoutMs ?? DEFAULT_LLM_CALL_TIMEOUT_MS;
  const repo = opts.repo;

  const structured = model.withStructuredOutput(PlanSchema, {
    name: "plan",
    includeRaw: true,
  });

  return async (
    state: GraphStateType,
    config?: RunnableConfig,
  ): Promise<Partial<GraphStateType>> => {
    // Phase 1 — ground in the repo. Best-effort by contract: a failed survey
    // returns "" and we plan blind rather than failing the run.
    const surveyed = repo
      ? await surveyRepo({
          model,
          repo,
          brief: state.context ? `${state.task}\n\n${state.context}` : state.task,
          llmCallTimeoutMs,
          signal: config?.signal,
        })
      : { survey: "", tokensUsed: 0 };

    // Phase 2 — turn task + findings into the plan.
    const systemPrompt =
      BASE_PROMPT + (surveyed.survey ? GROUNDED_PROMPT : "") + LANGUAGE_RULE;
    const prompt = [
      `# Task\n${state.task}`,
      state.context ? `# Project context\n${state.context}` : "",
      surveyed.survey ? `# Survey of the codebase (verified — plan against this)\n${surveyed.survey}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const { raw, parsed } = await withLlmTimeout(
      structured.invoke(
        [new SystemMessage(systemPrompt), new HumanMessage(prompt)],
        withUsage("architect", { signal: config?.signal }),
      ),
      llmCallTimeoutMs,
      "architect",
    );
    const plan = PlanSchema.parse(parsed).plan;
    const tokens =
      surveyed.tokensUsed + (billableTokens((raw as AIMessage).usage_metadata));

    return {
      plan,
      currentStep: 0,
      status: "running",
      tokensUsed: state.tokensUsed + tokens,
      messages: [
        {
          agent: "architect",
          role: "assistant",
          content: `Plan:\n${plan.map((s, i) => `${i + 1}. ${formatPlanStep(s)}`).join("\n")}`,
        },
      ],
    };
  };
}
