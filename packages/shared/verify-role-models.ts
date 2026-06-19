/**
 * Throwaway proof of per-role model configuration (M3 Trin 4): LLM_ROLE_MODELS
 * assigns each "team member" its own provider/model — Gemini for the critic,
 * Claude for the implementer, Mistral for the architect — unassigned roles fall
 * back to the default, and a bad config is rejected (typo role / missing key).
 * Run: pnpm --filter @arzonic/agent-shared exec tsx verify-role-models.ts
 */
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatMistralAI } from "@langchain/mistralai";
import { loadEnv } from "./src/env.js";
import { buildRoleModels, getModel } from "./src/llm.js";

const ok = (c: boolean, m: string) => {
  if (!c) throw new Error(`FAIL: ${m}`);
  console.log(`ok: ${m}`);
};

const LLM_KEYS = [
  "LLM_PROVIDER",
  "LLM_MODEL",
  "LLM_ROLE_MODELS",
  "MISTRAL_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
];
/** Set only the LLM-related env (deleting any leftover) so each case is hermetic. */
function setEnv(vars: Record<string, string>) {
  for (const k of LLM_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
}

// 1. Positive — three roles across three providers, plus a fallback default.
setEnv({
  LLM_PROVIDER: "mistral",
  MISTRAL_API_KEY: "dummy-mistral",
  ANTHROPIC_API_KEY: "dummy-anthropic",
  GOOGLE_API_KEY: "dummy-google",
  LLM_ROLE_MODELS: JSON.stringify({
    architect: { provider: "mistral" },
    critic: { provider: "google", model: "gemini-2.0-flash" },
    implementer: { provider: "anthropic", model: "claude-sonnet-4-6" },
  }),
});
const env = loadEnv();
const roles = buildRoleModels(env);
ok(roles.critic instanceof ChatGoogleGenerativeAI, "critic → Gemini (google)");
ok(roles.implementer instanceof ChatAnthropic, "implementer → Claude (anthropic)");
ok(roles.architect instanceof ChatMistralAI, "architect → Mistral");
ok(roles.worker === undefined, "an unconfigured role (worker) has no override → falls back to default");
ok(getModel(env) instanceof ChatMistralAI, "default model = LLM_PROVIDER (mistral)");

// 2. Negative — a typo'd role key is rejected (can't silently misconfigure the team).
let threw = false;
setEnv({
  LLM_PROVIDER: "mistral",
  MISTRAL_API_KEY: "dummy",
  LLM_ROLE_MODELS: JSON.stringify({ critik: { provider: "mistral" } }),
});
try {
  loadEnv();
} catch (e) {
  threw = true;
  ok(/unknown role/.test(String(e)), "unknown role key is rejected with a helpful message");
}
ok(threw, "a typo'd role name fails validation (not silently ignored)");

// 3. Negative — a role using a provider whose API key is missing is rejected.
threw = false;
setEnv({
  LLM_PROVIDER: "mistral",
  MISTRAL_API_KEY: "dummy",
  LLM_ROLE_MODELS: JSON.stringify({ critic: { provider: "google" } }),
});
try {
  loadEnv();
} catch (e) {
  threw = true;
  ok(/GOOGLE_API_KEY/.test(String(e)), "missing GOOGLE_API_KEY for a google role is flagged");
}
ok(threw, "configuring a role's provider without its API key fails validation");

// 4. Empty config — no overrides, the default model everywhere (back-compat).
setEnv({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "dummy" });
const env2 = loadEnv();
ok(Object.keys(buildRoleModels(env2)).length === 0, "no LLM_ROLE_MODELS → empty override map (one model everywhere)");
ok(getModel(env2) instanceof ChatAnthropic, "default resolves to the configured provider");

// 5. Per-mission override merges OVER the global env config (a mission's own team).
setEnv({
  LLM_PROVIDER: "mistral",
  MISTRAL_API_KEY: "dummy-mistral",
  ANTHROPIC_API_KEY: "dummy-anthropic",
  GOOGLE_API_KEY: "dummy-google",
  LLM_ROLE_MODELS: JSON.stringify({
    architect: { provider: "mistral" },
    critic: { provider: "google" },
  }),
});
const env3 = loadEnv();
// This mission overrides critic and adds implementer; architect inherits from env.
const missionModels = buildRoleModels(env3, {
  critic: { provider: "anthropic" },
  implementer: { provider: "anthropic", model: "claude-sonnet-4-6" },
});
ok(missionModels.critic instanceof ChatAnthropic, "mission override wins over the global config (critic env google → mission Claude)");
ok(missionModels.architect instanceof ChatMistralAI, "global env role survives where the mission doesn't override it (architect)");
ok(missionModels.implementer instanceof ChatAnthropic, "a mission-only role is added (implementer → Claude)");
ok(missionModels.worker === undefined, "a role in neither env nor mission has no override (falls back to default)");
// And no override = pure env config (back-compat with the global-only path).
const envOnly = buildRoleModels(env3);
ok(envOnly.critic instanceof ChatGoogleGenerativeAI && envOnly.implementer === undefined, "no mission override → exactly the global env config");

// 6. Three-level precedence the worker uses: env baseline → global default (DB) →
//    mission. Simulated by passing `{ ...globalDefault, ...missionRoleModels }`.
setEnv({
  LLM_PROVIDER: "mistral",
  MISTRAL_API_KEY: "dummy-mistral",
  ANTHROPIC_API_KEY: "dummy-anthropic",
  GOOGLE_API_KEY: "dummy-google",
  LLM_ROLE_MODELS: JSON.stringify({ replan: { provider: "mistral" } }), // env-only role
});
const env4 = loadEnv();
const globalDefault = { architect: { provider: "google" as const }, critic: { provider: "google" as const } };
const mission = { critic: { provider: "anthropic" as const } };
const resolved = buildRoleModels(env4, { ...globalDefault, ...mission });
ok(resolved.critic instanceof ChatAnthropic, "precedence: mission wins over global default (critic → Claude)");
ok(resolved.architect instanceof ChatGoogleGenerativeAI, "precedence: global default applies where the mission is silent (architect → Gemini)");
ok(resolved.replan instanceof ChatMistralAI, "precedence: env baseline survives where neither global nor mission set it (replan → Mistral)");

console.log("\nPer-role + per-mission + settings precedence verified ✓");
