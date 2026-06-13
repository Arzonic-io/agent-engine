import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatMistralAI } from "@langchain/mistralai";
import type { Env } from "./env.js";

const DEFAULT_MODELS = {
  mistral: "mistral-large-latest",
  anthropic: "claude-sonnet-4-6",
} as const;

export function getModel(env: Env): BaseChatModel {
  const model = env.LLM_MODEL ?? DEFAULT_MODELS[env.LLM_PROVIDER];

  switch (env.LLM_PROVIDER) {
    case "anthropic":
      return new ChatAnthropic({
        apiKey: env.ANTHROPIC_API_KEY,
        model,
        temperature: 0.2,
      });
    case "mistral":
      return new ChatMistralAI({
        apiKey: env.MISTRAL_API_KEY,
        model,
        temperature: 0.2,
      });
  }
}
