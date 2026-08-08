import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  HumanMessage,
  SystemMessage,
  type AIMessage,
} from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import { DEFAULT_LLM_CALL_TIMEOUT_MS, withLlmTimeout } from "../llmCallTimeout.js";
import type { GraphStateType } from "../state.js";

const SYSTEM_PROMPT = `You are the Architect of a small agent team. Break the task into a short,
ordered plan of 3-6 concrete, self-contained steps that, done in order, fully
deliver the task. Each step is one imperative sentence describing a tangible
piece of the work — no meta-steps like "review" or "plan". Order matters:
earlier steps produce what later steps build on.

LANGUAGE: Write the steps in the same language as the task — Danish if the task
is in Danish, otherwise English. Use only Danish or English.`;

const PlanSchema = z.object({
  plan: z
    .array(z.string())
    .min(1)
    .max(8)
    .describe("Ordered list of concrete steps, each one imperative sentence."),
});

export function makeArchitectNode(
  model: BaseChatModel,
  llmCallTimeoutMs: number = DEFAULT_LLM_CALL_TIMEOUT_MS,
) {
  const structured = model.withStructuredOutput(PlanSchema, {
    name: "plan",
    includeRaw: true,
  });

  return async (
    state: GraphStateType,
    config?: RunnableConfig,
  ): Promise<Partial<GraphStateType>> => {
    const prompt = state.context
      ? `# Task\n${state.task}\n\n# Project context\n${state.context}`
      : `# Task\n${state.task}`;
    const { raw, parsed } = await withLlmTimeout(
      structured.invoke(
        [new SystemMessage(SYSTEM_PROMPT), new HumanMessage(prompt)],
        { signal: config?.signal },
      ),
      llmCallTimeoutMs,
      "architect",
    );
    const plan = PlanSchema.parse(parsed).plan;
    const tokens = (raw as AIMessage).usage_metadata?.total_tokens ?? 0;

    return {
      plan,
      currentStep: 0,
      status: "running",
      tokensUsed: state.tokensUsed + tokens,
      messages: [
        {
          agent: "architect",
          role: "assistant",
          content: `Plan:\n${plan.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
        },
      ],
    };
  };
}
