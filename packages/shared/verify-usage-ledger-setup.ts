/**
 * Proof that the usage ledger's schema setup survives a first deploy, where the
 * API and the mission worker boot at the same moment and both create llm_usage.
 * Unserialized, the loser can fail with 23505 or 42P07 — and a process whose
 * setup() failed runs unmeasured for its lifetime. Two ledgers set up the schema
 * at once, five rounds, and both must succeed every time.
 * Needs the local Postgres (docker compose up -d), SUPABASE_DB_URL in .env and a
 * role that may create databases. Everything runs in a throwaway database on the
 * same server, dropped again at the end — the dev database is never touched.
 * Run: pnpm --filter @arzonic/agent-shared exec tsx verify-usage-ledger-setup.ts
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { BacklogService } from "./src/backlog.js";
import { loadEnv } from "./src/env.js";
import { MemoryService } from "./src/memory.js";
import { UsageLedgerService } from "./src/usageLedger.js";

const ok = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`ok: ${message}`);
};

const env = loadEnv();
if (!env.SUPABASE_DB_URL) {
  console.error("Need SUPABASE_DB_URL in .env (docker compose up -d).");
  process.exit(1);
}
const url = env.SUPABASE_DB_URL;

const ROUNDS = 5;
/** Lowercase letters, digits and underscores only, so it is safe unquoted in CREATE/DROP DATABASE. */
const database = `usage_setup_race_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
/** The same server and credentials, the throwaway database. */
const throwawayUrl = (() => {
  const target = new URL(url);
  target.pathname = `/${database}`;
  return target.toString();
})();

const admin = new pg.Pool({ connectionString: url });
await admin.query(`CREATE DATABASE ${database}`);
const inDb = new pg.Pool({ connectionString: throwawayUrl });

try {
  // The tables llm_usage references, in boot order: projects/tasks → missions/items.
  // The memory key is unused: setup() never embeds anything.
  const memory = new MemoryService({ connectionString: throwawayUrl, mistralApiKey: "unused-by-this-script" });
  const backlog = new BacklogService({ connectionString: throwawayUrl });
  try {
    await memory.setup();
    await backlog.setup();
  } finally {
    await backlog.end();
    await memory.end();
  }

  const failures: string[] = [];
  let incomplete = 0;
  for (let round = 1; round <= ROUNDS; round += 1) {
    // Two processes booting at once, each with its own pool — the API and the worker.
    const api = new UsageLedgerService({ connectionString: throwawayUrl });
    const worker = new UsageLedgerService({ connectionString: throwawayUrl });
    try {
      const results = await Promise.allSettled([api.setup(), worker.setup()]);
      for (const result of results) {
        if (result.status === "fulfilled") continue;
        const err = result.reason as { code?: unknown; message?: unknown };
        failures.push(`round ${round}: ${String(err.code ?? "?")} ${String(err.message ?? err)}`);
      }
    } finally {
      await api.end();
      await worker.end();
    }
    // The table and its three indexes (plus the primary key) are all there.
    const indexes = await inDb.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'llm_usage'`);
    if (indexes.rows.length !== 4) incomplete += 1;
    // Back to a first deploy for the next round.
    await inDb.query(`DROP TABLE IF EXISTS llm_usage`);
  }

  ok(
    failures.length === 0,
    `two ledgers setting up the schema at once both succeed, in all ${ROUNDS} rounds (failures: ${failures.length === 0 ? "none" : failures.join("; ")})`,
  );
  ok(incomplete === 0, `after every round llm_usage has its primary key and its three indexes (${incomplete} round(s) short)`);
} finally {
  await inDb.end();
  // FORCE: a backend that has not quite exited yet must not keep the throwaway database alive.
  await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  await admin.end();
}

console.log("\nUsage ledger schema setup ✓");
