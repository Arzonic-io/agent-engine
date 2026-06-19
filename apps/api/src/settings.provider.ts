import { AppSettingsService } from "@arzonic/agent-shared";
import type { ApiEnv } from "./env.js";

/**
 * Builds the Postgres-backed AppSettingsService (global app settings, e.g. the
 * default team config) and runs its idempotent schema setup. Returns null when
 * SUPABASE_DB_URL is missing — settings then fall back to env only. Mirrors
 * createBacklog/createMemory's "degrade gracefully" policy.
 */
export async function createSettings(env: ApiEnv): Promise<AppSettingsService | null> {
  if (!env.SUPABASE_DB_URL) {
    console.warn("[agent-api] SUPABASE_DB_URL missing — settings are read-only (env defaults).");
    return null;
  }
  const settings = new AppSettingsService({ connectionString: env.SUPABASE_DB_URL });
  await settings.setup();
  return settings;
}
