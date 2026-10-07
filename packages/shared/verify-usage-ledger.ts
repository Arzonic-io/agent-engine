/**
 * Proof that the Postgres usage ledger stores one row per call idempotently,
 * refuses rows whose mission is gone, and summarises a mission the way the panel
 * shows it: per role, per item (with attempts) and per finished item. Needs the
 * local Postgres (docker compose up -d) and SUPABASE_DB_URL in .env — like
 * verify-memory. Creates its own project and deletes it again (which cascades).
 * Run: pnpm --filter @arzonic/agent-shared exec tsx verify-usage-ledger.ts
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { BacklogService } from "./src/backlog.js";
import { loadEnv } from "./src/env.js";
import { MemoryService } from "./src/memory.js";
import { UsageLedgerService } from "./src/usageLedger.js";
import type { UsageRow } from "./src/usageRecorder.js";

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

// Schema in dependency order: projects/tasks → missions/items → llm_usage.
// The memory key is unused here: setup() and the raw inserts never embed anything.
const memory = new MemoryService({ connectionString: url, mistralApiKey: "unused-by-this-script" });
await memory.setup();
const backlog = new BacklogService({ connectionString: url });
await backlog.setup();
const ledger = new UsageLedgerService({ connectionString: url });
await ledger.setup();
await ledger.setup(); // idempotent

const pool = new pg.Pool({ connectionString: url });
const projectId = randomUUID();
const taskId = randomUUID();
await pool.query(`INSERT INTO projects (id, name) VALUES ($1, 'usage-ledger-verify')`, [projectId]);

try {
  const mission = await backlog.createMission({ projectId, goal: "Verify the ledger", repoPath: "/tmp/usage-verify" });
  const done = await backlog.createItem({ missionId: mission.id, title: "Done item" });
  const failed = await backlog.createItem({ missionId: mission.id, title: "Failed item" });
  await backlog.updateItem(done.id, { status: "done" });
  await backlog.updateItem(failed.id, { status: "failed" });
  await backlog.updateMission(mission.id, { spentTokens: 999 });

  const [a1, a2, a3] = [randomUUID(), randomUUID(), randomUUID()];
  const unknown = { usageKnown: false, inputFresh: null, cacheWrite: null, cacheRead: null, output: null, billable: null, costUsd: null };
  const row = (over: Partial<UsageRow>): UsageRow => ({
    callId: randomUUID(),
    at: new Date(),
    missionId: mission.id,
    itemId: null,
    attemptId: null,
    taskId: null,
    role: "implementer",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    status: "ok",
    calls: 1,
    usageKnown: true,
    inputFresh: 100,
    cacheWrite: 0,
    cacheRead: 0,
    output: 50,
    billable: 150,
    costUsd: 0.00105,
    latencyMs: 10,
    ...over,
  });

  const first = row({ itemId: done.id, attemptId: a1 });
  ok((await ledger.insert(first)) === "inserted", "a row is inserted");
  ok((await ledger.insert(first)) === "duplicate", "the same call twice is a duplicate, not a second row");
  await ledger.insert(row({ itemId: done.id, attemptId: a1, role: "missionCritic", billable: 50, costUsd: 0.0005 }));
  await ledger.insert(row({ itemId: failed.id, attemptId: a2, billable: 300, costUsd: 0.002 }));
  await ledger.insert(row({ itemId: failed.id, attemptId: a3, billable: 300, costUsd: 0.002 }));
  await ledger.insert(row({ role: "survey", billable: 400, costUsd: 0.003 }));
  await ledger.insert(row({ role: "replan", ...unknown }));
  await ledger.insert(row({ role: "unrecorded", status: "dropped", calls: 3, provider: null, model: null, ...unknown }));
  await ledger.insert(row({ role: "decompose", model: "gemini-2.5-flash", billable: 10, costUsd: null }));
  ok(
    (await ledger.insert(row({ missionId: randomUUID() }))) === "rejected",
    "a row for a mission that does not exist is refused, not thrown",
  );

  const s = await ledger.missionSummary(mission.id);
  ok(s.totals.billable === 1210, `total billable sums every known call (got ${s.totals.billable})`);
  ok(
    s.totals.unknownCalls === 1 && s.totals.droppedCalls === 3 && s.totals.unpricedCalls === 1,
    "unknown, dropped and unpriced calls are counted, not hidden",
  );
  ok(s.byRole[0]?.role === "implementer" && s.byRole[0].billable === 750, "roles sort by spend: implementer 150 + 300 + 300");
  const doneRow = s.byItem.find((i) => i.itemId === done.id);
  const failedRow = s.byItem.find((i) => i.itemId === failed.id);
  ok(doneRow?.attempts === 1 && doneRow.billable === 200 && doneRow.status === "done", "the done item: 1 attempt, 200 tokens");
  ok(failedRow?.attempts === 2 && failedRow.billable === 600, "the failed item: 2 attempts, 600 tokens");
  ok(
    s.outcome?.itemsDone === 1 &&
      s.outcome.billableOnDone === 200 &&
      s.outcome.billableOnOther === 600 &&
      s.outcome.billableShared === 410,
    "the outcome splits done / not done / shared (survey + decompose)",
  );
  ok(s.outcome?.billablePerDoneItem === 1210, "per finished item counts everything, waste included");
  ok(s.budgetCounted === 999, "the budget's own count is reported next to the measured one");
  ok(s.costComplete === false, "the cost is marked incomplete while calls are unknown, dropped or unpriced");
  ok(s.firstCallAt !== null, "the first measured call is dated");

  const empty = await ledger.missionSummary(randomUUID());
  ok(empty.totals.calls === 0 && empty.byRole.length === 0 && empty.firstCallAt === null, "an unmeasured mission summarises to nothing");

  await ledger.insert(row({ missionId: null, taskId, role: "router", billable: 20 }));
  const t = await ledger.taskSummary(taskId);
  ok(t.totals.billable === 20 && t.outcome === null && t.byItem.length === 0, "a run without a project summarises by its task id");
} finally {
  // Cascades: project → missions → items → their llm_usage rows.
  await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  await pool.query(`DELETE FROM llm_usage WHERE task_id = $1`, [taskId]); // no FK on task_id, so no cascade
  await pool.end();
  await ledger.end();
  await backlog.end();
  await memory.end();
}

console.log("\nUsage ledger ✓");
