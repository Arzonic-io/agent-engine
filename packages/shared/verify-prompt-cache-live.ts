/**
 * LIVE proof for M3 Trin 4 prompt caching — measures the actual cache tokens the
 * Anthropic API reports. Builds a Claude model with caching on (the default) and
 * sends the SAME large, stable prefix twice: the first call WRITES the cache
 * (cache_creation > 0), the second READS it (cache_read > 0, billed at ~0.1x).
 * That cache_read is the whole point — repeated stable context stops being
 * reprocessed at full price.
 * Run: pnpm --filter @arzonic/agent-shared exec tsx verify-prompt-cache-live.ts
 * Requires ANTHROPIC_API_KEY in .env (skips cleanly without it).
 */
import { HumanMessage, SystemMessage, type AIMessage } from "@langchain/core/messages";
import { loadEnv } from "./src/env.js";
import { buildModel } from "./src/llm.js";

const env = loadEnv();
if (!env.ANTHROPIC_API_KEY) {
  console.log("skipped — set ANTHROPIC_API_KEY in .env to run the live cache measurement.");
  process.exit(0);
}

const ok = (c: boolean, m: string) => {
  if (!c) throw new Error(`FAIL: ${m}`);
  console.log(`  ✓ ${m}`);
};

// A large, STABLE system prefix — padded well past the 2k/4k-token cache minimum so
// the breakpoint is guaranteed to take. Deterministic (no clock/random), so both
// calls render byte-identical and the second can read what the first wrote.
const systemText = [
  "You are a meticulous senior engineer reviewing an autonomous coding agent.",
  ...Array.from(
    { length: 400 },
    (_, i) =>
      `Guideline ${i + 1}: prefer the smallest correct change; ground every edit in code you have actually read; ` +
      `run the relevant check and read its real output; never claim done on a red build; keep the diff focused.`,
  ),
].join("\n");

const model = buildModel(env, { provider: "anthropic", model: env.LLM_MODEL ?? undefined });
const messages = [new SystemMessage(systemText), new HumanMessage("Reply with the single word: ready.")];

const usageOf = (res: AIMessage) => {
  const d = res.usage_metadata?.input_token_details as
    | { cache_creation?: number; cache_read?: number }
    | undefined;
  const raw = (res.response_metadata?.usage ?? {}) as {
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  return {
    creation: d?.cache_creation ?? raw.cache_creation_input_tokens ?? 0,
    read: d?.cache_read ?? raw.cache_read_input_tokens ?? 0,
    input: res.usage_metadata?.input_tokens ?? 0,
  };
};

console.log(`\nLive prompt cache: anthropic/${env.LLM_MODEL ?? "(default)"} — system prefix ≈ ${systemText.length} chars\n`);

const first = usageOf((await model.invoke(messages)) as AIMessage);
console.log(`Call 1 (cold):  input=${first.input}  cache_creation=${first.creation}  cache_read=${first.read}`);
const second = usageOf((await model.invoke(messages)) as AIMessage);
console.log(`Call 2 (warm):  input=${second.input}  cache_creation=${second.creation}  cache_read=${second.read}\n`);

ok(first.creation + first.read > 0, "call 1 engaged the cache (wrote, or read a still-warm prior entry)");
ok(second.read > 0, "call 2 READ the cached prefix — the stable context was NOT reprocessed at full price");
ok(second.read >= second.input, "the cached (≈0.1x) tokens outnumber the freshly-billed ones on the warm call");

console.log("🎉 M3 Trin 4 LIVE prompt cache PASSED — repeated stable context is served from cache.\n");
