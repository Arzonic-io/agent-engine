import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatMistralAI } from "@langchain/mistralai";
import { MODEL_ROLES, type ModelRole, type RoleModels } from "@arzonic/agent-core";
import type { Env, LlmProvider, RoleModelSpec } from "./env.js";

/** Default model id per provider, used when a spec leaves `model` unset. */
const DEFAULT_MODELS: Record<LlmProvider, string> = {
  mistral: "mistral-large-latest",
  anthropic: "claude-sonnet-4-6", // "Claude" for building
  google: "gemini-2.0-flash", // "Gemini Flash" for cheap, fast roles
};

/**
 * Build ONE chat model from an explicit `{ provider, model? }` spec, pulling the
 * matching API key out of the env. This is the single place provider SDKs are
 * instantiated — `getModel` (default) and `buildRoleModels` (per-role) both go
 * through it, so adding a provider is a one-case change here.
 */
export function buildModel(env: Env, spec: RoleModelSpec): BaseChatModel {
  const model = spec.model ?? DEFAULT_MODELS[spec.provider];
  switch (spec.provider) {
    case "anthropic":
      return new ChatAnthropic({
        apiKey: env.ANTHROPIC_API_KEY,
        model,
        temperature: 0.2,
        maxRetries: 2,
      });
    case "mistral":
      return new ChatMistralAI({
        apiKey: env.MISTRAL_API_KEY,
        model,
        temperature: 0.2,
        maxRetries: 2,
      });
    case "google":
      return new ChatGoogleGenerativeAI({
        apiKey: env.GOOGLE_API_KEY,
        model,
        temperature: 0.2,
        maxRetries: 2,
      });
  }
}

/** The default model — the fallback for any role without an explicit assignment. */
export function getModel(env: Env): BaseChatModel {
  return buildModel(env, { provider: env.LLM_PROVIDER, model: env.LLM_MODEL });
}

/**
 * Build the per-role model overrides (the configurable "team members") from
 * `LLM_ROLE_MODELS`. Returns a plain `RoleModels` map the graphs accept directly
 * via their `models` option — pair it with `getModel(env)` as the fallback:
 *
 *   createTeamGraph({ model: getModel(env), models: buildRoleModels(env), ... })
 *
 * Roles left unassigned simply fall back to the default model, so the map can be
 * empty (one model everywhere) or cover only the roles you want to specialise —
 * e.g. Gemini Flash for the critic, Claude for the implementer.
 */
export function buildRoleModels(env: Env): RoleModels {
  const cfg = env.LLM_ROLE_MODELS;
  if (!cfg) return {};
  const byRole: RoleModels = {};
  for (const role of MODEL_ROLES) {
    const spec = cfg[role as ModelRole];
    if (spec) byRole[role as ModelRole] = buildModel(env, spec);
  }
  return byRole;
}
