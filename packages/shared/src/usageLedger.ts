/**
 * The usage ledger: one row per model call in Postgres (llm_usage), and the
 * summaries the dashboard shows — per role, per item and per finished item.
 *
 * Rows reference missions and backlog_items (ON DELETE CASCADE, like the rest
 * of the schema), so run setup() AFTER BacklogService.setup(). task_id has no
 * foreign key: a run without a project has an ad-hoc id with no tasks row.
 */
import pg from "pg";
import { PRICE_TABLE_VERSION } from "./pricing.js";
import type { UsageInsertResult, UsageRow, UsageSink } from "./usageRecorder.js";

const { Pool } = pg;

export interface UsageTotals {
  /** Every call, gap rows included (their `calls`). */
  calls: number;
  /** Answered calls whose provider reported no usage. */
  unknownCalls: number;
  /** Calls that failed. */
  errorCalls: number;
  /** Calls lost before they reached the ledger. */
  droppedCalls: number;
  /** Calls with known usage but no price for their model. */
  unpricedCalls: number;
  inputFresh: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  /** The mission budget's unit. */
  billable: number;
  /** Estimated, from the calls that have a price. */
  costUsd: number;
}

export interface UsageByRole extends UsageTotals {
  role: string;
  models: string[];
}

export interface UsageByItem {
  itemId: string;
  title: string;
  status: string;
  attempts: number;
  calls: number;
  billable: number;
  costUsd: number;
}

export interface UsageOutcome {
  itemsDone: number;
  billableOnDone: number;
  billableOnOther: number;
  /** Mission-level work no item owns: the survey, planning, the done-judgement. */
  billableShared: number;
  /** Everything spent divided by what got done — waste and shared work included. Null while nothing is done or measured. */
  billablePerDoneItem: number | null;
  costPerDoneItemUsd: number | null;
}

export interface UsageSummary {
  totals: UsageTotals;
  byRole: UsageByRole[];
  /** Empty for an interactive run. */
  byItem: UsageByItem[];
  /** Null for an interactive run. */
  outcome: UsageOutcome | null;
  /** missions.spent_tokens — what the budget counted. Null for an interactive run. */
  budgetCounted: number | null;
  /** False while nothing is measured, or some calls are unknown, dropped or unpriced — the price is then a minimum. */
  costComplete: boolean;
  /** ISO time of the first measured call; null when nothing is measured yet. */
  firstCallAt: string | null;
  priceTableVersion: string;
}

/** One arbitrary fixed key, so concurrent boots serialize their schema setup. */
const USAGE_SCHEMA_LOCK = 4_190_731_582_620_217n;

const ROLE_TOTALS = `
  SELECT role,
    COALESCE(SUM(calls), 0)::float8 AS calls,
    COALESCE(SUM(calls) FILTER (WHERE status = 'ok' AND NOT usage_known), 0)::float8 AS unknown_calls,
    COALESCE(SUM(calls) FILTER (WHERE status = 'error'), 0)::float8 AS error_calls,
    COALESCE(SUM(calls) FILTER (WHERE status = 'dropped'), 0)::float8 AS dropped_calls,
    COALESCE(SUM(calls) FILTER (WHERE usage_known AND cost_usd IS NULL), 0)::float8 AS unpriced_calls,
    COALESCE(SUM(input_fresh), 0)::float8 AS input_fresh,
    COALESCE(SUM(cache_write), 0)::float8 AS cache_write,
    COALESCE(SUM(cache_read), 0)::float8 AS cache_read,
    COALESCE(SUM(output), 0)::float8 AS output,
    COALESCE(SUM(billable), 0)::float8 AS billable,
    COALESCE(SUM(cost_usd), 0)::float8 AS cost_usd,
    COALESCE(array_agg(DISTINCT model) FILTER (WHERE model IS NOT NULL), '{}') AS models
  FROM llm_usage`;

const ITEM_TOTALS = `
  SELECT bi.id AS item_id, bi.title, bi.status,
    COUNT(DISTINCT u.attempt_id)::float8 AS attempts,
    COALESCE(SUM(u.calls), 0)::float8 AS calls,
    COALESCE(SUM(u.billable), 0)::float8 AS billable,
    COALESCE(SUM(u.cost_usd), 0)::float8 AS cost_usd
  FROM backlog_items bi
  LEFT JOIN llm_usage u ON u.item_id = bi.id AND u.mission_id = bi.mission_id
  WHERE bi.mission_id = $1
  GROUP BY bi.id, bi.title, bi.status
  ORDER BY billable DESC, bi.title`;

type Row = Record<string, unknown>;
const num = (value: unknown): number => Number(value ?? 0);
const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);
const round6 = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;

function toRole(row: Row): UsageByRole {
  return {
    role: String(row.role),
    models: (row.models as string[] | null) ?? [],
    calls: num(row.calls),
    unknownCalls: num(row.unknown_calls),
    errorCalls: num(row.error_calls),
    droppedCalls: num(row.dropped_calls),
    unpricedCalls: num(row.unpriced_calls),
    inputFresh: num(row.input_fresh),
    cacheWrite: num(row.cache_write),
    cacheRead: num(row.cache_read),
    output: num(row.output),
    billable: num(row.billable),
    costUsd: round6(num(row.cost_usd)),
  };
}

function totalsOf(roles: UsageByRole[]): UsageTotals {
  const add = (pick: (r: UsageByRole) => number) => sum(roles.map(pick));
  return {
    calls: add((r) => r.calls),
    unknownCalls: add((r) => r.unknownCalls),
    errorCalls: add((r) => r.errorCalls),
    droppedCalls: add((r) => r.droppedCalls),
    unpricedCalls: add((r) => r.unpricedCalls),
    inputFresh: add((r) => r.inputFresh),
    cacheWrite: add((r) => r.cacheWrite),
    cacheRead: add((r) => r.cacheRead),
    output: add((r) => r.output),
    billable: add((r) => r.billable),
    costUsd: round6(add((r) => r.costUsd)),
  };
}

export class UsageLedgerService implements UsageSink {
  private readonly pool: pg.Pool;

  constructor(opts: { connectionString: string }) {
    this.pool = new Pool({ connectionString: opts.connectionString });
    // An idle client that Postgres drops must never crash the API or worker that only measures.
    this.pool.on("error", (err) =>
      console.warn("[usage] ledger connection error (pool keeps going):", err instanceof Error ? err.message : err),
    );
  }

  /**
   * Idempotent schema. Run after BacklogService.setup() — rows reference missions and backlog_items.
   * On a first deploy the API and the worker boot at once, and the loser of two concurrent CREATEs
   * fails (23505 or 42P07) and runs unmeasured for its lifetime. So the DDL runs in one transaction
   * behind an advisory lock: the second process waits, then finds everything in place.
   */
  async setup(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [USAGE_SCHEMA_LOCK]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS llm_usage (
          call_id      uuid PRIMARY KEY,
          at           timestamptz NOT NULL DEFAULT now(),
          mission_id   uuid REFERENCES missions(id) ON DELETE CASCADE,
          item_id      uuid REFERENCES backlog_items(id) ON DELETE CASCADE,
          attempt_id   uuid,
          task_id      uuid,
          role         text NOT NULL,
          provider     text,
          model        text,
          status       text NOT NULL DEFAULT 'ok',
          calls        integer NOT NULL DEFAULT 1,
          usage_known  boolean NOT NULL,
          input_fresh  bigint,
          cache_write  bigint,
          cache_read   bigint,
          output       bigint,
          billable     bigint,
          cost_usd     numeric(14, 6),
          latency_ms   integer
        )`);
      await client.query(`CREATE INDEX IF NOT EXISTS llm_usage_mission_idx ON llm_usage (mission_id)`);
      await client.query(`CREATE INDEX IF NOT EXISTS llm_usage_item_idx ON llm_usage (item_id)`);
      await client.query(`CREATE INDEX IF NOT EXISTS llm_usage_task_idx ON llm_usage (task_id)`);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async insert(row: UsageRow): Promise<UsageInsertResult> {
    try {
      const result = await this.pool.query(
        `INSERT INTO llm_usage (
           call_id, at, mission_id, item_id, attempt_id, task_id, role, provider, model, status,
           calls, usage_known, input_fresh, cache_write, cache_read, output, billable, cost_usd, latency_ms
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         ON CONFLICT (call_id) DO NOTHING`,
        [
          row.callId, row.at, row.missionId, row.itemId, row.attemptId, row.taskId, row.role,
          row.provider, row.model, row.status, row.calls, row.usageKnown, row.inputFresh,
          row.cacheWrite, row.cacheRead, row.output, row.billable, row.costUsd, row.latencyMs,
        ],
      );
      return result.rowCount === 1 ? "inserted" : "duplicate";
    } catch (err) {
      // A row the database refuses for good — a data error (22xxx: a malformed or out-of-range
      // value) or an integrity error (23xxx: its mission or item is gone (23503), a required
      // column is missing (23502), a check fails (23514)) — can never be stored, and retrying
      // it would stall the recorder's queue behind it: say why, and refuse it. Any other error
      // is rethrown, and the recorder keeps the row and retries it — a lost connection, say.
      const code = String((err as { code?: unknown }).code ?? "");
      if (code.startsWith("22") || code.startsWith("23")) {
        console.warn(
          `[usage] ledger refused a ${row.role} call (${row.callId}) for good: ${code} ${err instanceof Error ? err.message : String(err)}`,
        );
        return "rejected";
      }
      throw err;
    }
  }

  async missionSummary(missionId: string): Promise<UsageSummary> {
    const [roles, items, mission, first] = await Promise.all([
      this.pool.query(`${ROLE_TOTALS} WHERE mission_id = $1 GROUP BY role`, [missionId]),
      this.pool.query(ITEM_TOTALS, [missionId]),
      this.pool.query(`SELECT spent_tokens FROM missions WHERE id = $1`, [missionId]),
      this.pool.query(`SELECT min(at) AS first_at FROM llm_usage WHERE mission_id = $1`, [missionId]),
    ]);
    const byRole = roles.rows.map(toRole).sort((a, b) => b.billable - a.billable);
    const totals = totalsOf(byRole);
    const byItem: UsageByItem[] = items.rows.map((row: Row) => ({
      itemId: String(row.item_id),
      title: String(row.title),
      status: String(row.status),
      attempts: num(row.attempts),
      calls: num(row.calls),
      billable: num(row.billable),
      costUsd: round6(num(row.cost_usd)),
    }));
    // Nothing measured is unknown, not zero: a mission that ran before the ledger has no cost per item.
    const measured = totals.calls > 0;
    const done = byItem.filter((item) => item.status === "done");
    const billableOnDone = sum(done.map((item) => item.billable));
    const billableOnOther = sum(byItem.filter((item) => item.status !== "done").map((item) => item.billable));
    return {
      totals,
      byRole,
      byItem,
      outcome: {
        itemsDone: done.length,
        billableOnDone,
        billableOnOther,
        billableShared: totals.billable - billableOnDone - billableOnOther,
        billablePerDoneItem: done.length > 0 && measured ? Math.round(totals.billable / done.length) : null,
        costPerDoneItemUsd: done.length > 0 && measured ? round6(totals.costUsd / done.length) : null,
      },
      budgetCounted: mission.rows[0] ? num((mission.rows[0] as Row).spent_tokens) : null,
      costComplete: measured && totals.unknownCalls + totals.droppedCalls + totals.unpricedCalls === 0,
      firstCallAt: toIso((first.rows[0] as Row | undefined)?.first_at),
      priceTableVersion: PRICE_TABLE_VERSION,
    };
  }

  async taskSummary(taskId: string): Promise<UsageSummary> {
    const [roles, first] = await Promise.all([
      this.pool.query(`${ROLE_TOTALS} WHERE task_id = $1 GROUP BY role`, [taskId]),
      this.pool.query(`SELECT min(at) AS first_at FROM llm_usage WHERE task_id = $1`, [taskId]),
    ]);
    const byRole = roles.rows.map(toRole).sort((a, b) => b.billable - a.billable);
    const totals = totalsOf(byRole);
    return {
      totals,
      byRole,
      byItem: [],
      outcome: null,
      budgetCounted: null,
      costComplete: totals.calls > 0 && totals.unknownCalls + totals.droppedCalls + totals.unpricedCalls === 0,
      firstCallAt: toIso((first.rows[0] as Row | undefined)?.first_at),
      priceTableVersion: PRICE_TABLE_VERSION,
    };
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}

function toIso(value: unknown): string | null {
  return value instanceof Date ? value.toISOString() : null;
}
