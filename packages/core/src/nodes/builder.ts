import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { GraphStateType } from "../state.js";

const SYSTEM_PROMPT = `You are the Builder in a builder/critic loop. You produce the best possible
draft for the given task. When critic feedback is provided, you revise the
previous draft to resolve every issue — do not ignore feedback, do not start
over unless an issue demands it. Output ONLY the draft itself, no preamble,
no meta-commentary.`;

export function makeBuilderNode(model: BaseChatModel) {
  return async (state: GraphStateType): Promise<Partial<GraphStateType>> => {
    const parts = [`# Task\n${state.task}`];

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

    const response = await model.invoke([
      new SystemMessage(SYSTEM_PROMPT),
      new HumanMessage(parts.join("\n\n")),
    ]);

    const draft =
      typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content);
    const tokens = response.usage_metadata?.total_tokens ?? 0;

    return {
      draft,
      round: state.round + 1,
      tokensUsed: state.tokensUsed + tokens,
      status: "running",
      messages: [{ agent: "builder", role: "assistant", content: draft }],
    };
  };
}
