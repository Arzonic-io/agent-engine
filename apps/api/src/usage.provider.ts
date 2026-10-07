import { createUsageRecorder, UsageLedgerService, type UsageRecorder } from "@arzonic/agent-shared";
import type { ApiEnv } from "./env.js";

/** The usage ledger (llm_usage) and the recorder that feeds it. */
export interface UsageHandle {
  ledger: UsageLedgerService;
  recorder: UsageRecorder;
}

/**
 * Builds the usage ledger and its recorder. Run AFTER createBacklog: the table
 * references missions and backlog_items. Degrades to null — measuring must never
 * stop the app from booting — when there is no database or the schema can't be
 * created. Mirrors createBacklog/createMemory's "degrade gracefully" policy.
 */
export async function createUsage(env: ApiEnv, label = "agent-api"): Promise<UsageHandle | null> {
  if (!env.SUPABASE_DB_URL) {
    console.warn(`[${label}] SUPABASE_DB_URL missing — model usage is not measured.`);
    return null;
  }
  const ledger = new UsageLedgerService({ connectionString: env.SUPABASE_DB_URL });
  try {
    await ledger.setup();
  } catch (err) {
    console.warn(
      `[${label}] usage ledger disabled — schema setup failed:`,
      err instanceof Error ? err.message : err,
    );
    await ledger.end().catch(() => undefined);
    return null;
  }
  const recorder = createUsageRecorder(ledger, {
    // Cache writes are priced at the TTL this process writes them at.
    cacheTtl: env.LLM_PROMPT_CACHE_TTL,
    log: (message) => console.warn(`[${label}] ${message}`),
  });
  return { ledger, recorder };
}
