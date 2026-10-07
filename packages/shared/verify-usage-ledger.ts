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

/** Runs `action` with console.warn captured, so an expected warning is asserted instead of printed. */
const withWarnings = async <T>(action: () => Promise<T>): Promise<{ value: T; warnings: string[] }> => {
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  try {
    return { value: await action(), warnings };
  } finally {
    console.warn = realWarn;
  }
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
/** A run whose only call failed. */
const failedRunId = randomUUID();
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
  const gone = await withWarnings(() => ledger.insert(row({ missionId: randomUUID() })));
  ok(gone.value === "rejected", "a row for a mission that does not exist is refused, not thrown");
  ok(
    gone.warnings.length === 1 && gone.warnings[0]!.includes("23503") && gone.warnings[0]!.includes("implementer"),
    "the refusal is logged with its SQLSTATE and the role, so the real cause is not lost",
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

  // A dropped idle connection emits 'error' on the pool. Unhandled, that would crash the API or
  // worker that only measures; the ledger logs it and keeps working.
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  try {
    (ledger as unknown as { pool: { emit: (e: string, err: Error) => boolean } }).pool.emit("error", new Error("idle client dropped"));
  } finally {
    console.warn = realWarn;
  }
  ok(warnings.length === 1 && warnings[0]!.includes("idle client dropped"), "a dropped idle connection is logged, not thrown");
  ok(
    (await ledger.insert(row({ missionId: null, taskId, role: "router", billable: 5 }))) === "inserted",
    "the ledger keeps working after a pool error",
  );

  // A row that names an item but no mission is counted under neither: per-item and per-role
  // totals must count the same rows, or "shared" goes negative.
  const stray = await ledger.insert(
    row({ missionId: null, taskId, itemId: done.id, attemptId: a1, billable: 500, costUsd: 0.005 }),
  );
  const afterStray = await ledger.missionSummary(mission.id);
  const itemAfterStray = afterStray.byItem.find((i) => i.itemId === done.id)?.billable;
  ok(
    stray === "inserted" && itemAfterStray === 200 && afterStray.outcome?.billableShared === 410,
    `a row with an item but no mission changes neither the item's 200 nor the shared 410 (got ${itemAfterStray} and ${afterStray.outcome?.billableShared})`,
  );

  // Nothing measured is unknown, not zero: a mission that finished items before the ledger
  // existed has no cost per finished item, and its cost is not complete.
  const unmeasured = await backlog.createMission({ projectId, goal: "Nothing measured", repoPath: "/tmp/usage-verify" });
  const unmeasuredItem = await backlog.createItem({ missionId: unmeasured.id, title: "Finished, never measured" });
  await backlog.updateItem(unmeasuredItem.id, { status: "done" });
  const nothing = await ledger.missionSummary(unmeasured.id);
  ok(
    nothing.outcome?.itemsDone === 1 &&
      nothing.outcome.billablePerDoneItem === null &&
      nothing.outcome.costPerDoneItemUsd === null &&
      nothing.costComplete === false,
    `a mission with nothing measured has no cost per finished item (null, not 0) and an incomplete cost (got ${nothing.outcome?.billablePerDoneItem}, ${nothing.outcome?.costPerDoneItemUsd}, complete: ${nothing.costComplete})`,
  );
  ok((await ledger.taskSummary(randomUUID())).costComplete === false, "a run with nothing measured has an incomplete cost too");

  // Measured means at least one call with KNOWN usage. Gap rows and answered calls without usage
  // measure nothing, so a finished item's cost stays unknown — null, not a measured-looking 0.
  const onlyGaps = await backlog.createMission({ projectId, goal: "Only unmeasured calls", repoPath: "/tmp/usage-verify" });
  const onlyGapsItem = await backlog.createItem({ missionId: onlyGaps.id, title: "Finished, its calls unmeasured" });
  await backlog.updateItem(onlyGapsItem.id, { status: "done" });
  await ledger.insert(row({ missionId: onlyGaps.id, itemId: onlyGapsItem.id, ...unknown }));
  await ledger.insert(row({ missionId: onlyGaps.id, role: "unrecorded", status: "dropped", calls: 2, provider: null, model: null, ...unknown }));
  const gapsOnly = await ledger.missionSummary(onlyGaps.id);
  ok(
    gapsOnly.totals.calls === 3 &&
      gapsOnly.outcome?.itemsDone === 1 &&
      gapsOnly.outcome.billablePerDoneItem === null &&
      gapsOnly.outcome.costPerDoneItemUsd === null &&
      gapsOnly.costComplete === false,
    `a mission whose only calls are gap rows and unknown usage has no cost per finished item and an incomplete cost (got ${gapsOnly.outcome?.billablePerDoneItem}, ${gapsOnly.outcome?.costPerDoneItemUsd}, complete: ${gapsOnly.costComplete})`,
  );
  // A failed call carries no usage either: it measures nothing on a mission, nor on a run.
  await ledger.insert(row({ missionId: onlyGaps.id, role: "missionCritic", status: "error", ...unknown }));
  await ledger.insert(row({ missionId: null, taskId: failedRunId, role: "router", status: "error", ...unknown }));
  const withError = await ledger.missionSummary(onlyGaps.id);
  const failedRun = await ledger.taskSummary(failedRunId);
  ok(
    withError.totals.errorCalls === 1 &&
      withError.outcome?.billablePerDoneItem === null &&
      withError.costComplete === false &&
      failedRun.totals.errorCalls === 1 &&
      failedRun.costComplete === false,
    `failed calls measure nothing either (got ${withError.outcome?.billablePerDoneItem}, complete: ${withError.costComplete}; a run whose only call failed, complete: ${failedRun.costComplete})`,
  );

  // A row the database can never store is refused, not thrown: retrying it would stall the
  // recorder's queue behind it. Not only a missing mission (23503): a missing role breaks
  // NOT NULL (23502, an integrity error) and a fractional token count is a data error (22P02).
  const refusal = (over: Partial<UsageRow>): Promise<string> =>
    ledger
      .insert(row({ missionId: null, taskId, ...over }))
      .catch((err: unknown) => `threw ${String((err as { code?: unknown }).code ?? err)}`);
  const refused = await withWarnings(async () => ({
    noRole: await refusal({ role: null as unknown as string }),
    fractional: await refusal({ billable: 150.5 }),
  }));
  const { noRole, fractional } = refused.value;
  ok(
    noRole === "rejected" && fractional === "rejected",
    `a row that breaks NOT NULL or carries a malformed value is refused, not thrown (got ${noRole} and ${fractional})`,
  );
  // Each refusal says why, here and not in the recorder, which only ever sees "rejected".
  ok(
    refused.warnings.length === 2 &&
      refused.warnings[0]!.includes("23502") &&
      refused.warnings[1]!.includes("22P02") &&
      refused.warnings[1]!.includes("implementer"),
    "each refusal is logged with its SQLSTATE (and the call's role), so a malformed row is not blamed on a deleted mission",
  );
} finally {
  // Cascades: project → missions → items → their llm_usage rows.
  await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  await pool.query(`DELETE FROM llm_usage WHERE task_id = ANY($1::uuid[])`, [[taskId, failedRunId]]); // no FK on task_id, so no cascade
  await pool.end();
  await ledger.end();
  await backlog.end();
  await memory.end();
}

console.log("\nUsage ledger ✓");
