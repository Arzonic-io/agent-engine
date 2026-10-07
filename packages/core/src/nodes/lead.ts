import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { DEFAULT_LLM_CALL_TIMEOUT_MS, withLlmTimeout } from "../llmCallTimeout.js";
import type { GraphStateType } from "../state.js";
import { billableTokens } from "../tokens.js";
import { withUsage } from "../usage.js";

const SYSTEM_PROMPT = `You are the Lead of an agent team. The workers each produced one step of the
plan. Synthesize their outputs into ONE cohesive, polished final deliverable for
the task: resolve overlaps and contradictions, smooth the transitions, keep it
complete and well-structured. Do not just concatenate — integrate. When critic
issues or human guidance are provided, revise the deliverable to resolve them.
Output only the final deliverable.

LANGUAGE: Respond in the same language as the task — Danish if the task is in
Danish, otherwise English. Use only Danish or English.`;

export function makeLeadNode(
  model: BaseChatModel,
  llmCallTimeoutMs: number = DEFAULT_LLM_CALL_TIMEOUT_MS,
) {
  return async (
    state: GraphStateType,
    config?: RunnableConfig,
  ): Promise<Partial<GraphStateType>> => {
    const work = state.stepResults
      .map((r, i) => `## Step ${i + 1}: ${r.step}\n${r.output}`)
      .join("\n\n");

    const parts = [`# Task\n${state.task}`];
    if (state.context) parts.push(`# Project context\n${state.context}`);
    parts.push(`# Workers' step outputs\n${work}`);
    if (state.verdict && state.verdict.issues.length > 0) {
      parts.push(
        `# Critic issues to resolve\n${state.verdict.issues.map((i) => `- ${i}`).join("\n")}`,
      );
    }
    if (state.humanNotes) {
      parts.push(`# Human guidance (highest priority)\n${state.humanNotes}`);
    }

    const response = await withLlmTimeout(
      model.invoke(
        [new SystemMessage(SYSTEM_PROMPT), new HumanMessage(parts.join("\n\n"))],
        withUsage("lead", { signal: config?.signal }),
      ),
      llmCallTimeoutMs,
      "lead",
    );
    const synthesis =
      typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content);
    const tokens = billableTokens(response.usage_metadata);

    return {
      draft: synthesis,
      round: state.round + 1,
      status: "running",
      tokensUsed: state.tokensUsed + tokens,
      messages: [{ agent: "lead", role: "assistant", content: synthesis }],
    };
  };
}
