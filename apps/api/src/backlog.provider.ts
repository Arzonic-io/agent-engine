import { BacklogService } from "@arzonic/agent-shared";
import type { ApiEnv } from "./env.js";

/**
 * Builds the Postgres-backed BacklogService (missions + backlog_items) and runs
 * its idempotent schema setup. Returns null when SUPABASE_DB_URL is missing —
 * missions then stay disabled, while plain runs/projects still work. Mirrors
 * createMemory's "degrade gracefully" policy.
 */
export async function createBacklog(env: ApiEnv): Promise<BacklogService | null> {
  if (!env.SUPABASE_DB_URL) {
    console.warn("[agent-api] SUPABASE_DB_URL missing — missions are disabled.");
    return null;
  }
  const backlog = new BacklogService({ connectionString: env.SUPABASE_DB_URL });
  await backlog.setup();
  return backlog;
}
