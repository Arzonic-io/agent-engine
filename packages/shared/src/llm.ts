import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatMistralAI } from "@langchain/mistralai";
import {
  MODEL_ROLES,
  type ModelRole,
  type RoleModels,
  type RoleModelsConfig,
} from "@arzonic/agent-core";
import type { Env, LlmProvider, RoleModelSpec } from "./env.js";
import { llmRetryOnFailedAttempt, routeCompletionThroughTransientRetry } from "./retry.js";

/** Default model id per provider, used when a spec leaves `model` unset. */
const DEFAULT_MODELS: Record<LlmProvider, string> = {
  mistral: "mistral-large-latest",
  anthropic: "claude-sonnet-4-6", // "Claude" for building
  google: "gemini-2.0-flash", // "Gemini Flash" for cheap, fast roles
};

/**
 * ChatAnthropic with prompt caching defaulted ON (M3 Trin 4). The base model only
 * reads `cache_control` from per-call options, so a one-off `.withConfig(...)`
 * wouldn't survive — `createReactAgent` re-binds the model via `bindTools` and
 * `withStructuredOutput` does too, both dropping the bound call options. Overriding
 * `invocationParams` instead injects the breakpoint on EVERY underlying call while
 * staying a real `ChatAnthropic` (so `bindTools`/`withStructuredOutput` still
 * exist — a `RunnableBinding` would expose neither). The top-level `cache_control`
 * auto-places one ephemeral breakpoint on the last cacheable block and advances it
 * as the conversation grows: in the implementer/tester ReAct loop, tools + system +
 * the accumulated transcript are read from cache each tool round-trip. A caller can
 * still override per call (e.g. a 1h TTL); we only fill in the default.
 */
class CachingChatAnthropic extends ChatAnthropic {
  invocationParams(options?: this["ParsedCallOptions"]) {
    const params = super.invocationParams(options);
    if (!params.cache_control) params.cache_control = { type: "ephemeral" };
    return params;
  }
}

/**
 * Build ONE chat model from an explicit `{ provider, model? }` spec, pulling the
 * matching API key out of the env. This is the single place provider SDKs are
 * instantiated — `getModel` (default) and `buildRoleModels` (per-role) both go
 * through it, so adding a provider is a one-case change here.
 */
export function buildModel(env: Env, spec: RoleModelSpec): BaseChatModel {
  const model = spec.model ?? DEFAULT_MODELS[spec.provider];
  // Drift-robustness (M3 Trin 3): every provider routes its calls through
  // LangChain's AsyncCaller, which retries with exponential backoff + jitter up to
  // `maxRetries`. We make the count env-driven (survive a long night) and narrow
  // WHICH errors retry via `onFailedAttempt` — only transient ones (rate-limit /
  // 5xx / timeout); a 4xx / auth / quota / abort surfaces immediately.
  const retry = {
    maxRetries: env.MISSION_LLM_MAX_RETRIES,
    onFailedAttempt: llmRetryOnFailedAttempt,
  };
  switch (spec.provider) {
    case "anthropic": {
      // ChatAnthropic routes through this.caller, so the constructor option applies.
      // CachingChatAnthropic adds a default prompt-cache breakpoint (LLM_PROMPT_CACHE);
      // both are plain ChatAnthropic, so bindTools/withStructuredOutput are intact.
      const Anthropic = env.LLM_PROMPT_CACHE ? CachingChatAnthropic : ChatAnthropic;
      return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, model, temperature: 0.2, ...retry });
    }
    case "mistral":
      // ChatMistralAI ignores this.caller (builds a fresh one per request), so the
      // constructor onFailedAttempt is dropped — disable its internal retry and
      // route our transient-only policy onto its request method instead.
      return routeCompletionThroughTransientRetry(
        new ChatMistralAI({ apiKey: env.MISTRAL_API_KEY, model, temperature: 0.2, maxRetries: 0 }),
        env.MISSION_LLM_MAX_RETRIES,
      );
    case "google":
      return new ChatGoogleGenerativeAI({ apiKey: env.GOOGLE_API_KEY, model, temperature: 0.2, ...retry });
  }
}

/** The default model — the fallback for any role without an explicit assignment. */
export function getModel(env: Env): BaseChatModel {
  return buildModel(env, { provider: env.LLM_PROVIDER, model: env.LLM_MODEL });
}

/**
 * Build the per-role model overrides (the configurable "team members"). Returns a
 * plain `RoleModels` map the graphs accept directly via their `models` option —
 * pair it with `getModel(env)` as the fallback:
 *
 *   createTeamGraph({ model: getModel(env), models: buildRoleModels(env), ... })
 *
 * The global `LLM_ROLE_MODELS` is the base; an optional `override` (e.g. a
 * mission's persisted team config) wins per role, so a mission can specialise its
 * own agents on top of the global default. Roles left unassigned fall back to the
 * default model, so the result can be empty (one model everywhere) or cover only
 * the roles you specialise — e.g. Gemini Flash critic, Claude implementer.
 */
export function buildRoleModels(env: Env, override?: RoleModelsConfig): RoleModels {
  const merged: RoleModelsConfig = { ...(env.LLM_ROLE_MODELS ?? {}), ...(override ?? {}) };
  const byRole: RoleModels = {};
  for (const role of MODEL_ROLES) {
    const spec = merged[role as ModelRole];
    if (spec) byRole[role as ModelRole] = buildModel(env, spec);
  }
  return byRole;
}
