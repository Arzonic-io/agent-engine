/**
 * What a budget should count.
 *
 * LangChain folds Anthropic's cache counters into `usage_metadata`:
 *
 *   input_tokens = fresh + cache_creation + cache_read
 *   total_tokens = input_tokens + output_tokens
 *
 * so a cached token counts exactly as much as a freshly-processed one. In a ReAct
 * loop that is badly wrong, because the whole point of the cache is that the
 * prefix is re-read every turn: a 20k-token prefix over 24 tool turns counts as
 * ~480k tokens against the budget while actually costing about a tenth of that.
 * A mission then stops on "budget exceeded" having spent a fraction of it, and
 * the spend shown to the user is inflated by the same factor.
 *
 * So budgets count COST-WEIGHTED tokens instead: each class is scaled by what it
 * actually costs relative to a fresh input token.
 */

/** Anthropic's published multipliers, relative to a fresh input token. */
const CACHE_READ_WEIGHT = 0.1;
/** 5-minute cache writes are 1.25x; the 1h TTL is 2x, but 5m is the default here. */
const CACHE_WRITE_WEIGHT = 1.25;

/** The `usage_metadata` shape we depend on — structural, so no SDK type is imported. */
export interface UsageMetadataLike {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_token_details?: {
    cache_creation?: number;
    cache_read?: number;
  };
}

/**
 * Cost-weighted token count for one model response, for charging against a budget.
 *
 * Output tokens are deliberately NOT re-weighted even though they cost more per
 * token than input: that ratio differs per model, and turning the budget into a
 * true cost model is a bigger decision than fixing a miscount. This only corrects
 * the class that is both wrong AND repeated every turn.
 *
 * Providers that report no cache details (Mistral, Gemini) are unaffected —
 * everything is fresh input, and the result equals `total_tokens`.
 */
export function billableTokens(usage: UsageMetadataLike | undefined): number {
  if (!usage) return 0;
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const created = usage.input_token_details?.cache_creation ?? 0;
  const read = usage.input_token_details?.cache_read ?? 0;
  // `input_tokens` already includes both cache classes, so the remainder is the
  // genuinely fresh part. Clamped: a provider that ever reports them separately
  // must not produce a negative charge.
  const fresh = Math.max(0, input - created - read);
  return Math.round(fresh + created * CACHE_WRITE_WEIGHT + read * CACHE_READ_WEIGHT + output);
}
