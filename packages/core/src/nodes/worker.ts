import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { DEFAULT_LLM_CALL_TIMEOUT_MS, withLlmTimeout } from "../llmCallTimeout.js";
import type { GraphStateType } from "../state.js";

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
    const step = state.plan[state.currentStep] ?? "(no step)";
    const planList = state.plan.map((s, i) => `${i + 1}. ${s}`).join("\n");
    const prior = state.stepResults
      .map((r, i) => `## Step ${i + 1}: ${r.step}\n${r.output}`)
      .join("\n\n");

    const parts = [
      `# Task\n${state.task}`,
      state.context ? `# Project context\n${state.context}` : "",
      `# Full plan\n${planList}`,
      prior ? `# Completed so far\n${prior}` : "",
      `# Your step (${state.currentStep + 1}/${state.plan.length})\n${step}`,
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
    const tokens = response.usage_metadata?.total_tokens ?? 0;

    return {
      stepResults: [{ step, output }],
      draft: output,
      status: "running",
      tokensUsed: state.tokensUsed + tokens,
      messages: [
        {
          agent: "worker",
          role: "assistant",
          content: `**Step ${state.currentStep + 1}: ${step}**\n\n${output}`,
        },
      ],
    };
  };
}
