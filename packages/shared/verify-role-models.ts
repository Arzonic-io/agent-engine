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
  // Vertex/ADC route toggles — MUST be neutralised too, or a developer's real
  // .env (GOOGLE_CLOUD_PROJECT set) flips provider=google to ChatVertexAI and
  // breaks the ChatGoogleGenerativeAI assertions below.
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
];
/**
 * Pin the LLM-related env for one hermetic case. Keys are set to "" (NOT deleted):
 * `loadEnv()` re-reads the repo-root .env via dotenv, which fills in any ABSENT
 * key — so a deleted key would leak the developer's real value back in. An
 * existing "" blocks the dotenv fill and `cleanEnv` treats it as unset.
 */
function setEnv(vars: Record<string, string>) {
  for (const k of LLM_KEYS) process.env[k] = "";
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

// 7. Per-role TEMPERATURE flows to the built model; an adaptive-only Claude model
//    (Opus 4.7/4.8) DROPS it so it can't 400, while other models honour it.
setEnv({
  LLM_PROVIDER: "mistral",
  MISTRAL_API_KEY: "dummy-mistral",
  ANTHROPIC_API_KEY: "dummy-anthropic",
  LLM_ROLE_MODELS: JSON.stringify({
    critic: { provider: "mistral", temperature: 0 }, // deterministic critic
    architect: { provider: "mistral" }, // no temperature → runtime default
    implementer: { provider: "anthropic", model: "claude-sonnet-4-6", temperature: 0.5 }, // Claude that honours it
    tester: { provider: "anthropic", model: "claude-opus-4-8", temperature: 0 }, // Claude that rejects it
  }),
});
const env5 = loadEnv();
const tempRoles = buildRoleModels(env5);
const tempOf = (m: unknown) => (m as { temperature?: number }).temperature;
ok(tempOf(tempRoles.critic) === 0, "per-role temperature flows to the model (critic = 0, deterministic)");
ok(tempOf(tempRoles.architect) === 0.2, "a role with no temperature gets the runtime default (0.2)");
ok(tempOf(tempRoles.implementer) === 0.5, "a temperature-honouring Claude (Sonnet 4.6) keeps the configured temperature");
ok(tempOf(tempRoles.tester) === undefined, "an adaptive-only Claude (Opus 4.8) DROPS temperature (it would 400 otherwise)");
// And the drop actually prevents the 400 — invocationParams validates sampling-param compat.
let invocThrew = false;
try {
  (tempRoles.tester as unknown as { invocationParams: () => unknown }).invocationParams();
} catch {
  invocThrew = true;
}
ok(!invocThrew, "building Opus 4.8 with the default temperature no longer throws at invocation (latent bug fixed)");

// 8. Vertex/ADC route: GOOGLE_CLOUD_PROJECT set (no API key) routes provider=google
//    through ChatVertexAI — and the key-based route stays ChatGoogleGenerativeAI.
//    Instantiation only (ADC credentials are first touched at call time); the live
//    call is proven separately in verify-vertex-live.ts.
const { ChatVertexAI } = await import("@langchain/google-vertexai");
setEnv({
  LLM_PROVIDER: "mistral",
  MISTRAL_API_KEY: "dummy-mistral",
  GOOGLE_CLOUD_PROJECT: "dummy-project",
  LLM_ROLE_MODELS: JSON.stringify({ critic: { provider: "google" } }),
});
const env6 = loadEnv();
const vertexRoles = buildRoleModels(env6);
ok(vertexRoles.critic instanceof ChatVertexAI, "GOOGLE_CLOUD_PROJECT (no key) → google routes through Vertex/ADC");
ok(
  !(vertexRoles.critic instanceof ChatGoogleGenerativeAI),
  "the Vertex route does NOT instantiate the key-based Gemini SDK",
);

console.log("\nPer-role + per-mission + settings precedence + temperature verified ✓");
