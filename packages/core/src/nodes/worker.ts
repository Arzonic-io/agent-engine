import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { DEFAULT_LLM_CALL_TIMEOUT_MS, withLlmTimeout } from "../llmCallTimeout.js";
import { formatPlanStep, toPlanStep, type GraphStateType } from "../state.js";
import { billableTokens } from "../tokens.js";

const SYSTEM_PROMPT = `You are a Worker on an agent team, executing exactly ONE step of a plan.
Produce the concrete deliverable for your step — the actual content, not a
description of it. Use the task and the already-completed steps as context, and
make your output fit cohesively with them. Do not redo other steps. Output only
your step's deliverable, no preamble.

LANGUAGE: Respond in the same language as the task — Danish if the task is in
Danish, otherwise English. Use only Danish or English.`;

export function makeWorkerNode(
  model: BaseChatModel,
  llmCallTimeoutMs: number = DEFAULT_LLM_CALL_TIMEOUT_MS,
) {
  return async (
    state: GraphStateType,
    config?: RunnableConfig,
  ): Promise<Partial<GraphStateType>> => {
    // Coerce on read: a checkpoint written before the plan became structured is
    // rehydrated verbatim as string[], bypassing the channel's reducer.
    const raw = state.plan[state.currentStep];
    const step = raw ? toPlanStep(raw) : { title: "(no step)", files: [] };
    // The full plan stays titles-only — the worker needs the shape of the whole,
    // but only its OWN step's spec. Repeating every step's files/verify would
    // bloat the prompt with detail for work it must not do.
    const planList = state.plan
      .map((s, i) => `${i + 1}. ${toPlanStep(s).title}`)
      .join("\n");
    const prior = state.stepResults
      .map((r, i) => `## Step ${i + 1}: ${r.step}\n${r.output}`)
      .join("\n\n");

    const parts = [
      `# Task\n${state.task}`,
      state.context ? `# Project context\n${state.context}` : "",
      `# Full plan\n${planList}`,
      prior ? `# Completed so far\n${prior}` : "",
      `# Your step (${state.currentStep + 1}/${state.plan.length})\n${formatPlanStep(step)}`,
    ].filter(Boolean);

    const response = await withLlmTimeout(
      model.invoke(
        [new SystemMessage(SYSTEM_PROMPT), new HumanMessage(parts.join("\n\n"))],
        { signal: config?.signal },
      ),
      llmCallTimeoutMs,
      "worker",
    );
    const output =
      typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content);
    const tokens = billableTokens(response.usage_metadata);

    return {
      stepResults: [{ step: step.title, output }],
      draft: output,
      status: "running",
      tokensUsed: state.tokensUsed + tokens,
      messages: [
        {
          agent: "worker",
          role: "assistant",
          content: `**Step ${state.currentStep + 1}: ${step.title}**\n\n${output}`,
        },
      ],
    };
  };
}
