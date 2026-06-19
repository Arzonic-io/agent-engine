import type { RoleModelsConfig } from "@arzonic/agent-core";
import pg from "pg";

const { Pool } = pg;

/**
 * App-wide settings, persisted in the same Postgres the rest of the runtime uses.
 * A tiny key→jsonb store so settings can be CHANGED at runtime from the UI (env
 * vars can't be). Today it holds the global default team config (`role_models`);
 * the key/value shape leaves room for more settings without a migration each time.
 *
 * Resolution order for a mission's models is: env `LLM_ROLE_MODELS` (baseline) →
 * this global default (DB) → the mission's own `roleModels` (most specific wins).
 */

const ROLE_MODELS_KEY = "role_models";

export interface AppSettingsServiceOptions {
  connectionString: string;
}

export class AppSettingsService {
  private readonly pool: pg.Pool;

  constructor(opts: AppSettingsServiceOptions) {
    this.pool = new Pool({ connectionString: opts.connectionString });
  }

  /** Idempotent schema setup — run once at boot. */
  async setup(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key        text PRIMARY KEY,
        value      jsonb NOT NULL DEFAULT '{}',
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
  }

  async getValue<T = unknown>(key: string): Promise<T | null> {
    const { rows } = await this.pool.query(`SELECT value FROM app_settings WHERE key=$1`, [key]);
    return rows[0] ? (rows[0].value as T) : null;
  }

  async setValue(key: string, value: unknown): Promise<void> {
    await this.pool.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1,$2,now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
  }

  /** The global default per-role model config — the UI-editable team default. */
  async getRoleModels(): Promise<RoleModelsConfig> {
    return (await this.getValue<RoleModelsConfig>(ROLE_MODELS_KEY)) ?? {};
  }

  async setRoleModels(cfg: RoleModelsConfig): Promise<void> {
    await this.setValue(ROLE_MODELS_KEY, cfg);
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}
