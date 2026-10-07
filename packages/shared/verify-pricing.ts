/**
 * Proof that the price table prices known models from their list price, matches
 * dated model ids to their family, and leaves a model without a verified price
 * unknown (null) instead of free. Pure — no key, no DB.
 * Run: pnpm --filter @arzonic/agent-shared exec tsx verify-pricing.ts
 */
import { PRICE_TABLE_VERSION, estimateCostUsd, priceFor } from "./src/pricing.js";

const ok = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`ok: ${message}`);
};

const none = { inputFresh: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
const M = 1_000_000;

ok(estimateCostUsd("claude-sonnet-4-6", { ...none, inputFresh: M }) === 3, "Sonnet 4.6 input is $3 per 1M");
ok(estimateCostUsd("claude-sonnet-4-6", { ...none, output: M }) === 15, "Sonnet 4.6 output is $15 per 1M");
ok(estimateCostUsd("claude-sonnet-4-6", { ...none, cacheRead: M }) === 0.3, "Sonnet 4.6 cache reads are $0.30 per 1M");
ok(estimateCostUsd("claude-sonnet-4-6", { ...none, cacheWrite: M }) === 3.75, "Sonnet 4.6 cache writes are $3.75 per 1M (5-minute TTL)");
ok(estimateCostUsd("claude-sonnet-4-6-20260101", { ...none, output: M }) === 15, "a dated model id prices like its family");
ok(estimateCostUsd("claude-opus-5-5", { ...none, cacheRead: M }) === 0.2, "Opus 5.5 cache reads are $0.20 per 1M");
ok(estimateCostUsd("claude-sonnet-5-5", { ...none, inputFresh: M, output: M }) === 12, "Sonnet 5.5: $2 in + $10 out");
ok(estimateCostUsd("claude-haiku-4-5", { ...none, inputFresh: M }) === 1, "Haiku 4.5 input is $1 per 1M");
ok(
  estimateCostUsd("mistral-large-latest", { ...none, inputFresh: 2 * M, output: M }) === 2.5,
  "Mistral Large 3: 2M in + 1M out = $2.50",
);
ok(estimateCostUsd("gemini-2.5-flash", { ...none, inputFresh: M }) === null, "a model without a verified price is unknown, not free");
ok(estimateCostUsd(null, { ...none, inputFresh: M }) === null, "no model, no price");
ok(priceFor("CLAUDE-HAIKU-4-5")?.input === 1, "matching ignores case");
ok(/^\d{4}-\d{2}-\d{2}$/.test(PRICE_TABLE_VERSION), "the table carries the date its prices were checked");
ok(estimateCostUsd("claude-sonnet-4-6", { ...none, cacheWrite: M }, "1h") === 6, "Sonnet 4.6 cache writes at the 1-hour TTL are $6 per 1M (2x input)");
ok(estimateCostUsd("claude-opus-5-5", { ...none, cacheWrite: M }, "1h") === 8, "Opus 5.5 cache writes at the 1-hour TTL are $8 per 1M");
ok(estimateCostUsd("claude-sonnet-4-6", { ...none, cacheWrite: M }) === 3.75, "the TTL defaults to 5 minutes");
ok(estimateCostUsd("mistral-large-latest", { ...none, cacheWrite: M }, "1h") === null, "a cache write with no price at its TTL makes the price unknown, not cheaper");
ok(estimateCostUsd("mistral-large-latest", { ...none, inputFresh: M }, "1h") === 0.5, "a call without cache writes is still priced at any TTL");

console.log("\nPrice table ✓");
