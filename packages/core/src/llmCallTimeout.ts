/**
 * Provider-agnostic LLM call timeout. Node code additionally passes
 * `{ signal: config?.signal }` into the underlying `model.invoke(...)` call so a
 * provider that honors `AbortSignal` (verified: Anthropic) frees the real socket
 * — but that alone is not a safe bound: verified directly against
 * `@langchain/mistralai`'s source, Mistral (this app's actual default provider,
 * see `LLM_PROVIDER` in packages/shared/src/env.ts) does NOT forward the signal
 * into its underlying request at all, so a truly hung Mistral call would never
 * be interrupted by `{signal}` alone.
 *
 * `withLlmTimeout` guarantees the calling `await` settles within `ms` regardless
 * of whether the underlying provider ever resolves or honors cancellation —
 * `Promise.race` doesn't care whether the loser ever finishes. This is what
 * actually lets a hung node call fail instead of hanging a run (or, on the
 * `decide()`/"revise" path, the HTTP request itself) forever.
 */
export const DEFAULT_LLM_CALL_TIMEOUT_MS = 120_000;

export async function withLlmTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} call timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
