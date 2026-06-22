/**
 * Throwaway proof for M3 Trin 4 prompt caching (Anthropic). No API key, no network:
 * proves the WIRING that makes caching actually fire across the codebase's two call
 * shapes —
 *   1. buildModel(anthropic) with LLM_PROMPT_CACHE on injects a default top-level
 *      ephemeral cache breakpoint into invocationParams (and respects an explicit
 *      per-call override, e.g. a 1h TTL); off ⇒ no breakpoint (raw uncached tokens).
 *   2. the caching model stays a real ChatAnthropic — bindTools + withStructuredOutput
 *      still exist and createReactAgent accepts it — so the breakpoint survives the
 *      re-binds that a `.withConfig(...)` RunnableBinding would have dropped. This is
 *      the whole reason for the subclass over .withConfig.
 *   3. caching is Anthropic-only: a mistral/google spec is untouched.
 * The live token measurement (cache_creation then cache_read) lives in
 * verify-prompt-cache-live.ts (needs a key).
 * Run: pnpm --filter @arzonic/agent-shared exec tsx verify-prompt-cache.ts
 */
import { ChatAnthropic } from "@langchain/anthropic";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { Env } from "./src/env.js";
import { buildModel } from "./src/llm.js";

const ok = (c: boolean, m: string) => {
  if (!c) throw new Error(`FAIL: ${m}`);
  console.log(`ok: ${m}`);
};

// Minimal Env with only the fields buildModel reads — keys are never used (no network).
const baseEnv = {
  MISSION_LLM_MAX_RETRIES: 2,
  ANTHROPIC_API_KEY: "sk-test",
  MISTRAL_API_KEY: "m-test",
  GOOGLE_API_KEY: "g-test",
} as const;
const envWith = (LLM_PROMPT_CACHE: boolean): Env =>
  ({ ...baseEnv, LLM_PROMPT_CACHE }) as unknown as Env;

const cacheOf = (m: unknown) =>
  // invocationParams is public ("Get the parameters used to invoke the model") and is
  // exactly what bindTools / withStructuredOutput / createReactAgent call through to.
  (m as ChatAnthropic).invocationParams().cache_control as
    | { type: string; ttl?: string }
    | undefined;

// ── 1. LLM_PROMPT_CACHE on ⇒ a default ephemeral breakpoint on every Anthropic call ──
const cached = buildModel(envWith(true), { provider: "anthropic", model: "claude-sonnet-4-6" });
ok(cached instanceof ChatAnthropic, "caching model is a real ChatAnthropic (not a RunnableBinding)");
ok(cacheOf(cached)?.type === "ephemeral", "LLM_PROMPT_CACHE=true defaults cache_control to ephemeral");

// ── 2. off ⇒ no breakpoint (raw, uncached — what you'd set to measure the baseline) ──
const raw = buildModel(envWith(false), { provider: "anthropic", model: "claude-sonnet-4-6" });
ok(raw instanceof ChatAnthropic, "non-caching model is still a plain ChatAnthropic");
ok(cacheOf(raw) === undefined, "LLM_PROMPT_CACHE=false leaves cache_control unset (no breakpoint)");

// ── 3. an explicit per-call cache_control wins — we only fill in the DEFAULT ──
const overridden = (cached as ChatAnthropic).invocationParams({
  cache_control: { type: "ephemeral", ttl: "1h" },
} as never).cache_control as { ttl?: string };
ok(overridden?.ttl === "1h", "an explicit per-call cache_control (1h TTL) is preserved, not overwritten");

// ── 4. still tool-callable: bindTools + withStructuredOutput survive (a RunnableBinding
//       from .withConfig would expose NEITHER), so the implementer/tester ReAct loop
//       (createReactAgent calls llm.bindTools) and the structured nodes keep working ──
ok(typeof cached.bindTools === "function", "caching model exposes bindTools (createReactAgent calls it)");
ok(typeof cached.withStructuredOutput === "function", "caching model exposes withStructuredOutput (critic/replan/decompose need it)");
const dummy = tool(async () => "ok", {
  name: "noop",
  description: "does nothing",
  schema: z.object({}),
});
const bound = cached.bindTools([dummy]);
ok(typeof bound.invoke === "function", "bindTools returns an invokable runnable (the ReAct loop's tool-call shape)");
ok(typeof cached.withStructuredOutput(z.object({ ok: z.boolean() })).invoke === "function", "withStructuredOutput returns an invokable runnable");

// ── 5. Anthropic-only: a non-Anthropic spec is untouched (Mistral/Gemini ignore caching) ──
const mistral = buildModel(envWith(true), { provider: "mistral", model: "mistral-large-latest" });
ok(!(mistral instanceof ChatAnthropic), `a mistral spec is NOT an Anthropic model (${mistral.constructor.name}) — caching does not touch it`);
const google = buildModel(envWith(true), { provider: "google", model: "gemini-2.0-flash" });
ok(!(google instanceof ChatAnthropic), `a google spec is NOT an Anthropic model (${google.constructor.name}) — caching does not touch it`);

console.log("\n🎉 M3 Trin 4 prompt-cache WIRING PASSED — Claude calls default to a cache breakpoint, the model stays tool-callable, and other providers are untouched.\n");
