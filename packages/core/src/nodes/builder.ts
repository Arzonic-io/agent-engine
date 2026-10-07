import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { DEFAULT_LLM_CALL_TIMEOUT_MS, withLlmTimeout } from "../llmCallTimeout.js";
import type { GraphStateType } from "../state.js";
import { billableTokens } from "../tokens.js";
import { withUsage } from "../usage.js";

const SYSTEM_PROMPT = `You are the Builder in a builder/critic loop. You produce the best possible
draft for the given task. When critic feedback is provided, you revise the
previous draft to resolve every issue — do not ignore feedback, do not start
over unless an issue demands it. Output ONLY the draft itself, no preamble,
no meta-commentary.

LANGUAGE: Respond in the same language as the task. If the task is written in
Danish, write entirely in Danish; otherwise write in English. Use only Danish
or English — never any other language.`;

export function makeBuilderNode(
  model: BaseChatModel,
  llmCallTimeoutMs: number = DEFAULT_LLM_CALL_TIMEOUT_MS,
) {
  return async (
    state: GraphStateType,
    config?: RunnableConfig,
  ): Promise<Partial<GraphStateType>> => {
    const parts = [`# Task\n${state.task}`];
    if (state.context) parts.push(`# Project context\n${state.context}`);

    if (state.draft) {
      parts.push(`# Previous draft\n${state.draft}`);
    }
    if (state.verdict && state.verdict.issues.length > 0) {
      parts.push(
        `# Critic issues to resolve\n${state.verdict.issues
          .map((i) => `- ${i}`)
          .join("\n")}`,
      );
    }
    if (state.humanNotes) {
      parts.push(
        `# Human guidance (highest priority — incorporate this)\n${state.humanNotes}`,
      );
    }

    const response = await withLlmTimeout(
      model.invoke(
        [new SystemMessage(SYSTEM_PROMPT), new HumanMessage(parts.join("\n\n"))],
        withUsage("builder", { signal: config?.signal }),
      ),
      llmCallTimeoutMs,
      "builder",
    );

    const draft =
      typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content);
    const tokens = billableTokens(response.usage_metadata);

    return {
      draft,
      round: state.round + 1,
      tokensUsed: state.tokensUsed + tokens,
      status: "running",
      messages: [{ agent: "builder", role: "assistant", content: draft }],
    };
  };
}
