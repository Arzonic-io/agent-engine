/**
 * Estimated USD price of a model call, from the provider's list price per
 * million tokens. This is the price the usage ledger stores next to the raw token
 * counts — so models can be compared on money, not on the budget's token unit
 * (billableTokens weights cache reads and writes but prices every output token
 * like an input token).
 *
 * Only prices verified on PRICE_TABLE_VERSION are listed. A model that isn't
 * listed has an UNKNOWN price (null), never 0: a zero would quietly make an
 * unpriced model look free. Adding one is a single row — never a guess.
 *
 * Sources (checked 2026-10-07): Anthropic's list prices (cache writes at
 * 1.25× input for the 5-minute TTL, 2× input for 1 hour), Mistral Large 3
 * (2512) at $0.50 / $1.50.
 */
export const PRICE_TABLE_VERSION = "2026-10-07";

/** The prompt-cache lifetime the call's writes were made at, from LLM_PROMPT_CACHE_TTL. */
export type CacheTtl = "5m" | "1h";

/** USD per 1M tokens, per token class. */
export interface ModelPrice {
  input: number;
  output: number;
  /** USD per 1M tokens written to the prompt cache at the 5-minute TTL. */
  cacheWrite: number;
  /** USD per 1M tokens written to the prompt cache at the 1-hour TTL; null where the provider has no 1-hour tier. */
  cacheWrite1h: number | null;
  cacheRead: number;
}

/** A call's tokens, split the way providers bill them. */
export interface TokenCounts {
  inputFresh: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

/** Longest matching prefix wins, so a dated id (claude-sonnet-4-6-2026…) prices like its family. */
const PRICES: ReadonlyArray<readonly [prefix: string, price: ModelPrice]> = [
  ["claude-opus-5-5", { input: 4, output: 20, cacheWrite: 5, cacheWrite1h: 8, cacheRead: 0.2 }],
  ["claude-sonnet-5-5", { input: 2, output: 10, cacheWrite: 2.5, cacheWrite1h: 4, cacheRead: 0.2 }],
  ["claude-sonnet-4-6", { input: 3, output: 15, cacheWrite: 3.75, cacheWrite1h: 6, cacheRead: 0.3 }],
  ["claude-haiku-4-5", { input: 1, output: 5, cacheWrite: 1.25, cacheWrite1h: 2, cacheRead: 0.1 }],
  // Mistral reports no cache classes; both are priced as input to stay safe.
  ["mistral-large-2512", { input: 0.5, output: 1.5, cacheWrite: 0.5, cacheWrite1h: null, cacheRead: 0.5 }],
  // `-latest` pointed at Large 3 (2512) on PRICE_TABLE_VERSION. Re-check when Mistral moves it.
  ["mistral-large-latest", { input: 0.5, output: 1.5, cacheWrite: 0.5, cacheWrite1h: null, cacheRead: 0.5 }],
];

/** The list price for a model id, or null when it has no verified price. */
export function priceFor(model: string | null | undefined): ModelPrice | null {
  if (!model) return null;
  const id = model.trim().toLowerCase();
  let best: ModelPrice | null = null;
  let bestLength = -1;
  for (const [prefix, price] of PRICES) {
    if (id.startsWith(prefix) && prefix.length > bestLength) {
      best = price;
      bestLength = prefix.length;
    }
  }
  return best;
}

/** Estimated USD for one call, rounded to a millionth of a dollar; null when the model has no price. */
export function estimateCostUsd(
  model: string | null | undefined,
  counts: TokenCounts,
  cacheTtl: CacheTtl = "5m",
): number | null {
  const price = priceFor(model);
  if (!price) return null;
  const writePrice = cacheTtl === "1h" ? price.cacheWrite1h : price.cacheWrite;
  if (counts.cacheWrite > 0 && writePrice === null) return null;
  const usd =
    (counts.inputFresh * price.input +
      counts.cacheWrite * (writePrice ?? 0) +
      counts.cacheRead * price.cacheRead +
      counts.output * price.output) /
    1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}
