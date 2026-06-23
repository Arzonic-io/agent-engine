import type {
  BacklogItem,
  BacklogItemStatus,
  BacklogStore,
  CreateBacklogItemInput,
  DiffResult,
  Mission,
  MissionStatus,
  Risk,
} from "./mission.js";
import { buildDigest, classifyRisk, type MissionDigest } from "./humanPolicy.js";
import type { WorkResult, WorkRunner } from "./runner.js";
import type { Verifier, VerifierReport } from "./verifier.js";

/**
 * The mission controller loop (§5.3) — a pure async function. It keeps feeding
 * backlog items to the existing graphs until the goal is met or a governor
 * stops it. All I/O is injected (BacklogStore, Verifier, WorkRunner, Replanner,
 * Notifier, Clock) so `core` stays framework-free. State lives entirely in the
 * BacklogStore, so re-invoking `runMission(missionId)` after a crash resumes:
 * any item left `in_progress` is requeued, and `nextActionable` picks up where
 * it left off.
 *
 * This step ships the full loop with safe termination. The smart replan (Trin 5,
 * lead agent) and the richer governors/kill-switch (Trin 6) slot in behind the
 * `Replanner` and `MissionGovernors` seams without touching the loop.
 */

// ── Replan seam (Trin 5 replaces the default with a lead agent) ──

export interface ReplanInput {
  mission: Mission;
  item: BacklogItem;
  result: WorkResult;
  verification: VerifierReport;
}

export interface ReplanDecision {
  /** New status for the worked item — done when verified, else failed/parked/retry. */
  itemStatus: BacklogItemStatus;
  /** Follow-up items the replan wants added to the backlog. */
  followUps?: Omit<CreateBacklogItemInput, "missionId">[];
  /** One-line note for the journal/digest. */
  note?: string;
  /** Tokens the replan step itself spent, folded into the mission budget. */
  tokensUsed?: number;
}

export interface Replanner {
  replan(input: ReplanInput): Promise<ReplanDecision>;
}

/**
 * Deterministic default: the Verifier's pass/fail is the truth — verified ⇒
 * done, otherwise failed. No follow-ups, no LLM. Trin 5 swaps in the lead agent
 * that retries, adds follow-ups, and parks high-risk work.
 */
export const defaultReplanner: Replanner = {
  async replan({ verification }) {
    return { itemStatus: verification.passed ? "done" : "failed" };
  },
};

// ── Decompose seam (M3 Trin 1: grow the initial backlog from the goal) ──

/**
 * One item a `Decomposer` proposes. Dependencies are expressed by `key` —
 * a local slug naming another item in the SAME batch — because real ids don't
 * exist until the store creates the rows. The controller resolves keys → ids.
 */
export interface DecomposedItem {
  /** Local slug used to declare dependencies within this batch (not persisted). */
  key?: string;
  title: string;
  detail?: string;
  /** Higher = worked sooner. */
  priority?: number;
  /** Keys of other items in THIS batch that must be done first. */
  dependsOn?: string[];
  risk?: Risk;
}

export interface DecomposeInput {
  mission: Mission;
  /** Titles already in the backlog (usually empty at decompose time). */
  existingTitles?: string[];
}

export interface DecomposeResult {
  items: DecomposedItem[];
  /** One-line note for the journal/digest. */
  note?: string;
  /** Tokens the decompose step spent, folded into the mission budget. */
  tokensUsed?: number;
}

/**
 * Turns a mission goal into an initial backlog. Injected like every other seam;
 * the LLM impl is `makeDecomposer`. Called once, only when the backlog is empty,
 * so resume never re-decomposes.
 */
export interface Decomposer {
  decompose(input: DecomposeInput): Promise<DecomposeResult>;
}

/**
 * Persist a decomposed batch, resolving `key`-based dependencies to real item
 * ids. Two passes so any DAG works without topological sorting: create every
 * item (recording key → id), then patch `dependsOn` with the resolved ids.
 * Keys that don't resolve (typo / cycle-to-self) are dropped defensively, so a
 * model slip can never wedge the loop. Pure — no I/O beyond the injected store.
 */
export async function createDecomposedItems(
  backlog: BacklogStore,
  missionId: string,
  items: DecomposedItem[],
): Promise<BacklogItem[]> {
  const created: BacklogItem[] = [];
  const keyToId = new Map<string, string>();
  for (const it of items) {
    const row = await backlog.createItem({
      missionId,
      title: it.title,
      detail: it.detail,
      priority: it.priority,
      risk: it.risk,
    });
    created.push(row);
    if (it.key) keyToId.set(it.key, row.id);
  }
  for (let i = 0; i < items.length; i++) {
    const deps = items[i]!.dependsOn ?? [];
    if (deps.length === 0) continue;
    const ids = [...new Set(deps.map((k) => keyToId.get(k)).filter((x): x is string => !!x))]
      .filter((id) => id !== created[i]!.id); // never depend on yourself
    if (ids.length > 0) {
      created[i] = (await backlog.updateItem(created[i]!.id, { dependsOn: ids })) ?? created[i]!;
    }
  }
  return created;
}

// ── TestAuthor seam (M3 Trin 2: a green build is only strong truth if a test
//    actually exercises the code) ──

export interface TestAuthorInput {
  mission: Mission;
  /** The backlog item the implementer just built. */
  item: BacklogItem;
  /** The work result — `result.worktree` is the tree the test must be authored in. */
  result: WorkResult;
}

export interface TestAuthorResult {
  /** Whether a test file was actually written/edited (best-effort, for the journal). */
  authored: boolean;
  /** One-line note for the journal/digest. */
  note?: string;
  /** Tokens the test-authoring step spent, folded into the mission budget. */
  tokensUsed?: number;
}

/**
 * Authors a test that exercises the just-built code, in the item's worktree,
 * BEFORE the Verifier runs — so "green" means a real test passed, not merely
 * "it compiles" (M3 Trin 2). Injected like every other seam; the LLM impl is
 * `makeTestAuthor`. It only WRITES a test file: it never reports pass/fail and
 * never decides "done" — the Verifier's exit code stays the sole truth (a test
 * that fails the buggy code keeps the item open, which is the point). Optional:
 * omitted ⇒ exactly the pre-Trin-2 behaviour. Should be best-effort and not throw
 * (the controller also guards the call, since it runs inside the concurrent batch
 * where a rejection would strand sibling items).
 */
export interface TestAuthor {
  authorTest(input: TestAuthorInput): Promise<TestAuthorResult>;
}

// ── Notifier seam (Trin 7 wires real transport) ──

export type MissionEvent =
  | { type: "item_started"; missionId: string; item: BacklogItem }
  | { type: "item_finished"; missionId: string; item: BacklogItem; status: BacklogItemStatus }
  | { type: "item_parked"; missionId: string; item: BacklogItem; reason: string }
  | { type: "item_retried"; missionId: string; item: BacklogItem; attempt: number; reason: string }
  /** The morning digest (M3 Trin 6), delivered when the mission stops — log now, mail/Slack later. */
  | { type: "mission_digest"; missionId: string; digest: MissionDigest }
  | { type: "mission_stopped"; missionId: string; status: MissionStatus; reason: string };

export interface Notifier {
  notify(event: MissionEvent): Promise<void> | void;
}

// ── Integration seam (Trin 5: merge a green item into the mission branch) ──

export interface MergeResult {
  /** false on a merge conflict (the impl aborts the merge, leaving the branch clean). */
  merged: boolean;
  /** git output / conflict detail for the journal. */
  output: string;
}

/**
 * Integrates a worktree-green item into the mission's integration branch. The
 * controller orchestrates merge → re-verify (via the Verifier) → rollback/cleanup
 * so the Verifier stays the single truth source. Pure git ops only; injected like
 * every other seam. Undefined ⇒ no integration (the read-only planning runner).
 */
export interface Integrator {
  /**
   * Merge the item's branch into the integration branch. The impl first commits
   * the implementer's (uncommitted) changes in `worktree` onto the item branch,
   * then merges that branch — so authored code actually flows into the mission branch.
   */
  merge(input: { itemId: string; branch: string; worktree?: string }): Promise<MergeResult>;
  /** Undo the last merge after a red post-merge build, restoring the branch. */
  rollback(): Promise<void>;
  /** Tear down the item's worktree after a successful integration. */
  cleanup(itemId: string): Promise<void>;
}

// ── Differ seam (M3 Trin 5: show a human what the item actually wrote) ──

/**
 * Computes the structured diff of the code an item authored — the changed files
 * (with ±lines) plus the unified patch — so a human can SEE the change before
 * Godkend/Afvis, especially on parked items. Pure git ops only; injected like
 * every other seam. The controller calls it on the item's WORKTREE, where the
 * implementer's changes are still uncommitted, BEFORE the Verifier runs (so build
 * artifacts don't pollute the diff) and before the Integrator commits/merges — so
 * a done item shows what merged and a parked item shows what was attempted, the
 * same way. Best-effort: the impl should never throw (the controller also guards
 * the call), and it must not disturb the worktree the Integrator later commits.
 */
export interface Differ {
  /** Structured diff of the authored (uncommitted) changes in an item's worktree. */
  diff(worktree: string): Promise<DiffResult>;
}

// ── Clock seam — no Date.now() in core; the runtime injects time ──

export interface Clock {
  /** Current epoch ms. */
  now(): number;
}

// ── Governors (Trin 6 hardens these; the loop needs basic ceilings now) ──

export interface MissionGovernors {
  /** Backstop iteration cap. */
  maxIterations?: number;
  /** Token ceiling; falls back to `mission.budget`. */
  tokenBudget?: number | null;
  /** Consecutive iterations with no newly-done item before stopping. Default 3. */
  noProgressLimit?: number;
  /** ISO wall-clock stop; falls back to `mission.deadline`. Needs an injected Clock. */
  deadline?: string | null;
  /**
   * Times one item may fail (not reach done) before it is parked as
   * `blocked_needs_human` instead of retried again. Parks the item, NOT the
   * mission — the loop moves on to other work. Default 3.
   */
  thrashLimit?: number;
  /**
   * How many actionable items to run concurrently, each in its own worktree
   * (Trin 6). Execution + per-worktree verification run in parallel; integration
   * (merge + re-verify on the shared mission branch) stays SEQUENTIAL. Default 1
   * — identical to the serial loop. Keep conservative; dependencies + sequential
   * merge already bound how much can truly overlap.
   */
  concurrency?: number;
  /**
   * Times one item whose run throws a TRANSIENT/infra error (per `isTransientError`)
   * is re-queued before being parked as `blocked_needs_human` instead of re-queued
   * again — so a persistent outage still terminates. SEPARATE from `thrashLimit`
   * (which counts logic failures): an infra blip must not burn the logic budget,
   * nor vice-versa. Default 5.
   */
  requeueLimit?: number;
}

export interface MissionDeps {
  backlog: BacklogStore;
  verifier: Verifier;
  runner: WorkRunner;
  /** Grows the initial backlog from the goal when it's empty (M3 Trin 1). Optional. */
  decomposer?: Decomposer;
  /** Authors a test exercising the built code before verification (M3 Trin 2). Optional. */
  testAuthor?: TestAuthor;
  /**
   * Classifies a thrown error as a TRANSIENT/infrastructure failure (rate-limit /
   * 5xx / timeout / network) vs. a real one (M3 Trin 3). Injected from shared so
   * core imports no SDK/error types. A transient run failure is re-queued; anything
   * else is surfaced as a failed item. Optional — omitted ⇒ every throw is treated
   * as non-transient (no re-queue), i.e. the pre-Trin-3 classification.
   */
  isTransientError?: (err: unknown) => boolean;
  replanner?: Replanner;
  notifier?: Notifier;
  clock?: Clock;
  /** Merges green items into the mission branch + re-verifies (Trin 5). Optional. */
  integrator?: Integrator;
  /**
   * Computes the structured diff of what an item authored, stored on the item so a
   * human can review it before Godkend/Afvis (M3 Trin 5). Optional — omitted ⇒ no
   * diff captured (exactly the pre-Trin-5 behaviour). Best-effort: a throw is caught.
   */
  differ?: Differ;
  governors?: MissionGovernors;
  /** Checks the Verifier runs per item. Default ["typecheck", "test"]. */
  checks?: string[];
  /** Extra patterns that force an item to high-risk (from MISSION_HIGH_RISK_PATTERNS). */
  highRiskPatterns?: string[];
  /** Abort signal forwarded to each work item run. */
  signal?: AbortSignal;
}

export interface MissionOutcome {
  status: MissionStatus;
  /** Machine-readable stop reason: done | blocked | budget | deadline | max-iterations | no-progress | stopped | not-found. */
  reason: string;
  iterations: number;
  itemsDone: number;
}

/** Goal + acceptance criteria, prepended to every work item as steering context. */
function missionContext(m: Mission): string {
  const lines = [`Mission goal: ${m.goal}`];
  if (m.acceptanceCriteria.length > 0) {
    lines.push(`Acceptance criteria:\n${m.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`);
  }
  return lines.join("\n\n");
}

/** Short, safe text for a thrown error — for journal notes (never the control path). */
function errText(err: unknown, max = 2000): string {
  const s = err instanceof Error ? err.message || err.name : String(err);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Collapse a multi-check report into the single Verification stored on an item. */
function summarizeVerification(checks: string[], report: VerifierReport) {
  const failed = report.results.filter((r) => !r.passed);
  const output = (failed.length ? failed : report.results)
    .map((r) => `[${r.check}] ${r.passed ? "pass" : "FAIL"}\n${r.output}`)
    .join("\n\n");
  return { passed: report.passed, check: checks.join(","), output };
}

export async function runMission(
  deps: MissionDeps,
  missionId: string,
): Promise<MissionOutcome> {
  const { backlog, verifier, runner } = deps;
  const replanner = deps.replanner ?? defaultReplanner;
  const checks = deps.checks ?? ["typecheck", "test"];
  const noProgressLimit = deps.governors?.noProgressLimit ?? 3;
  const thrashLimit = deps.governors?.thrashLimit ?? 3;
  const requeueLimit = deps.governors?.requeueLimit ?? 5;
  const isTransient = deps.isTransientError ?? (() => false);
  /** Per-item LOGIC-failure count for this run — drives the thrash guard. */
  const attempts = new Map<string, number>();
  /** Per-item TRANSIENT/infra re-queue count — kept separate from `attempts` (M3 Trin 3). */
  const requeues = new Map<string, number>();

  const loaded = await backlog.getMission(missionId);
  if (!loaded) {
    return { status: "failed", reason: "not-found", iterations: 0, itemsDone: 0 };
  }
  // Non-null for the closures below (a reassigned `let` would widen back to null).
  let mission: Mission = loaded;

  // Resume hygiene: an item left mid-run by a crash goes back to the queue.
  const existing = await backlog.listItems(missionId);
  for (const it of existing) {
    if (it.status === "in_progress") await backlog.updateItem(it.id, { status: "todo" });
  }

  // Decompose (M3 Trin 1): grow the initial backlog from the goal — but ONLY when
  // it's empty, so a resume (or a manually-seeded mission) is never re-planned.
  if (deps.decomposer && existing.length === 0) {
    const plan = await deps.decomposer.decompose({ mission });
    await createDecomposedItems(backlog, missionId, plan.items);
    if (plan.tokensUsed) {
      mission =
        (await backlog.updateMission(missionId, {
          spentTokens: mission.spentTokens + plan.tokensUsed,
        })) ?? mission;
    }
  }

  let iterations = 0;
  let itemsDone = 0;
  let noProgress = 0;

  const stop = async (status: MissionStatus, reason: string): Promise<MissionOutcome> => {
    await backlog.updateMission(missionId, { status });
    // Deliver the morning digest (M3 Trin 6) via the Notifier as the mission ends —
    // a rollup of what's done, what's blocking + why, and the next high-risk work.
    if (deps.notifier) {
      const items = await backlog.listItems(missionId);
      const digest = buildDigest({ ...mission, status }, items, deps.highRiskPatterns);
      await deps.notifier.notify({ type: "mission_digest", missionId, digest });
    }
    await deps.notifier?.notify({ type: "mission_stopped", missionId, status, reason });
    return { status, reason, iterations, itemsDone };
  };

  /**
   * Pick up to `limit` actionable items, parking high-risk ones (§5.5) before any
   * execution. Marks each picked item in_progress + notifies started. Marking
   * in_progress keeps a dependent out of the SAME batch (its dep isn't done yet),
   * so dependency order is preserved across concurrent items.
   */
  const pickBatch = async (limit: number): Promise<BacklogItem[]> => {
    const batch: BacklogItem[] = [];
    while (batch.length < limit) {
      const next = await backlog.nextActionable(missionId);
      if (!next) break;
      if (classifyRisk(next, deps.highRiskPatterns) === "high") {
        const parked =
          (await backlog.updateItem(next.id, { status: "blocked_needs_human", risk: "high" })) ?? next;
        await deps.notifier?.notify({ type: "item_parked", missionId, item: parked, reason: "high-risk" });
        continue;
      }
      iterations++;
      await backlog.updateItem(next.id, { status: "in_progress" });
      await deps.notifier?.notify({ type: "item_started", missionId, item: next });
      batch.push(next);
    }
    return batch;
  };

  type ItemOutcome =
    | {
        kind: "ran";
        item: BacklogItem;
        result: WorkResult;
        report: VerifierReport;
        decision: ReplanDecision;
        /** Diff of the authored changes (M3 Trin 5), captured before verify/integrate. */
        diff: DiffResult | null;
      }
    | { kind: "requeue"; item: BacklogItem; reason: string }
    | { kind: "error"; item: BacklogItem; error: unknown };

  /**
   * Execute one item in its worktree, verify the authored code, replan.
   * Parallel-safe AND throw-safe: any error is caught and turned into an outcome
   * (M3 Trin 3) so it can never reject the batch's `Promise.all` and strand
   * siblings. A TRANSIENT/infra error becomes a `requeue`; anything else becomes an
   * `error` finalize routes to the failed/thrash path — surfaced, never swallowed.
   */
  const runAndReplan = async (item: BacklogItem): Promise<ItemOutcome> => {
    try {
      return await runItem(item);
    } catch (err) {
      if (isTransient(err)) return { kind: "requeue", item, reason: errText(err, 300) };
      return { kind: "error", item, error: err };
    }
  };

  const runItem = async (item: BacklogItem): Promise<ItemOutcome> => {
    const result = await runner.run(
      { id: item.id, title: item.title, detail: item.detail, context: missionContext(mission) },
      deps.signal,
    );
    await backlog.updateItem(item.id, { runId: result.runId });
    // Author a missing test (M3 Trin 2) in the worktree BEFORE verifying, so the
    // same Verifier run that gates "done" also exercises the new test — "green"
    // then means a real test passed, not merely that it compiles. Only when the
    // runner ran write-capably (a worktree exists); the test author never reports
    // pass/fail (the Verifier exit code stays the truth). Its tokens fold into the
    // per-item spend — result is a local per-item object, safe to mutate here even
    // though finalize (which reads result.tokensUsed) runs sequentially.
    if (deps.testAuthor && result.worktree) {
      try {
        const authored = await deps.testAuthor.authorTest({ mission, item, result });
        if (authored.tokensUsed) result.tokensUsed += authored.tokensUsed;
      } catch {
        // Best-effort: the tester never decides "done", so a throw must not reject
        // this batch's Promise.all and strand its sibling items. The Verifier still
        // runs whatever tests already exist.
      }
    }
    // Capture the diff of the authored code (M3 Trin 5) HERE — after the
    // implementer + test author wrote, but BEFORE the Verifier runs (so build
    // artifacts from the checks don't pollute it) and before the Integrator
    // commits/merges. Same capture point whether the item ends up done or parked,
    // so a human always sees what was actually written. Best-effort: a git hiccup
    // must not strand the item, so a throw just leaves the diff null.
    let diff: DiffResult | null = null;
    if (deps.differ && result.worktree) {
      try {
        diff = await deps.differ.diff(result.worktree);
      } catch {
        // Diff is for human review only — never gate the loop on it.
      }
    }
    // Verify the AUTHORED code where it was written: the item's worktree when the
    // runner ran write-capably (Trin 4), else the mission repo (planning runner).
    const report = await verifier.run(checks, result.worktree);
    const decision = await replanner.replan({ mission, item, result, verification: report });
    return { kind: "ran", item, result, report, decision, diff };
  };

  /**
   * Close out one item: integrate (Trin 5), apply the thrash guard, persist the
   * status + follow-ups + spend, and update progress counters. MUST run
   * sequentially across a batch — integration mutates the shared mission branch.
   */
  const finalize = async (outcome: ItemOutcome): Promise<void> => {
    // M3 Trin 3 — transient/infra recovery: re-queue the item (back to todo)
    // instead of failing it, bounded by requeueLimit so a persistent outage still
    // terminates. Counts as no-progress (so the no-progress governor can stop a
    // long outage) but NOT as a thrash attempt (an infra blip must not burn the
    // logic-failure budget). The Verifier never saw this item — there is no verdict
    // to feed replan; re-queue is orthogonal to pass/fail.
    // Note: a thrown run carries no WorkResult, so any tokens the LLM burned before
    // the throw are intentionally NOT folded into spentTokens here (both this and
    // the error branch) — a small, bounded budget-accuracy gap, not a leak.
    if (outcome.kind === "requeue") {
      const { item } = outcome;
      const n = (requeues.get(item.id) ?? 0) + 1;
      requeues.set(item.id, n);
      if (n > requeueLimit) {
        const parked =
          (await backlog.updateItem(item.id, {
            status: "blocked_needs_human",
            verification: {
              passed: false,
              check: "infrastructure",
              output: `Gave up after ${n - 1} transient retries — needs a human. Last error: ${outcome.reason}`,
            },
          })) ?? item;
        noProgress = 0; // parking resolves it out of the pool — that's progress
        await deps.notifier?.notify({ type: "item_parked", missionId, item: parked, reason: "infrastructure" });
        return;
      }
      const requeued = (await backlog.updateItem(item.id, { status: "todo" })) ?? item;
      noProgress++; // re-queue is not progress — a persistent outage trips no-progress
      await deps.notifier?.notify({ type: "item_retried", missionId, item: requeued, attempt: n, reason: outcome.reason });
      return;
    }

    // A non-transient throw (or no transient predicate): the run crashed without
    // producing a verdict — abnormal, and retrying a deterministic crash won't
    // help. PARK it for a human with the error recorded, so it is surfaced loudly
    // (the mission ends "blocked", not a misleading "done") and never swallowed or
    // crashing the loop. This also contains a throw that would otherwise reject the
    // batch's Promise.all and strand siblings.
    if (outcome.kind === "error") {
      const { item } = outcome;
      const parked =
        (await backlog.updateItem(item.id, {
          status: "blocked_needs_human",
          verification: { passed: false, check: "run-error", output: errText(outcome.error) },
        })) ?? item;
      noProgress = 0; // parking resolves it out of the pool — that's progress
      await deps.notifier?.notify({ type: "item_parked", missionId, item: parked, reason: "run-error" });
      return;
    }

    const { item, result, report, decision, diff } = outcome;
    let effectiveStatus = decision.itemStatus;
    let verification = summarizeVerification(checks, report);

    // Integration (Trin 5): a worktree-green item must ALSO merge into the
    // mission branch and pass re-verification there before it counts as done —
    // two independently-green items can still sum to a red integration. A merge
    // conflict, or a red post-merge build (rolled back), parks the item for a
    // human; the mission branch stays green.
    if (effectiveStatus === "done" && deps.integrator && result.branch) {
      const merge = await deps.integrator.merge({
        itemId: item.id,
        branch: result.branch,
        worktree: result.worktree,
      });
      if (!merge.merged) {
        effectiveStatus = "blocked_needs_human";
        verification = {
          passed: false,
          check: "integration",
          output: `Merge conflict integrating into the mission branch — needs a human.\n\n${merge.output}`,
        };
      } else {
        const postMerge = await verifier.run(checks);
        if (!postMerge.passed) {
          await deps.integrator.rollback();
          effectiveStatus = "blocked_needs_human";
          verification = {
            passed: false,
            check: `integration:${checks.join(",")}`,
            output: `Post-merge build is red — merge rolled back, mission branch kept green.\n\n${summarizeVerification(checks, postMerge).output}`,
          };
        } else {
          await deps.integrator.cleanup(item.id);
          verification = summarizeVerification(checks, postMerge);
        }
      }
    }

    // Thrash guard: an item that keeps FAILING (not one parked above) is parked
    // for a human, not retried forever. Parking it (not the mission) lets the
    // loop move on.
    if (effectiveStatus !== "done" && effectiveStatus !== "blocked_needs_human") {
      const fails = (attempts.get(item.id) ?? 0) + 1;
      attempts.set(item.id, fails);
      if (fails >= thrashLimit) effectiveStatus = "blocked_needs_human";
    }

    const finished =
      (await backlog.updateItem(item.id, {
        status: effectiveStatus,
        verification,
        // Persist the authored diff (M3 Trin 5) so the dashboard can show what the
        // item wrote — most useful on a parked item awaiting Godkend/Afvis. Only
        // overwrite when we actually captured one, never clobbering with null.
        ...(diff ? { diff } : {}),
      })) ?? item;
    for (const f of decision.followUps ?? []) {
      await backlog.createItem({ ...f, missionId });
    }

    mission =
      (await backlog.updateMission(missionId, {
        spentTokens: mission.spentTokens + result.tokensUsed + (decision.tokensUsed ?? 0),
      })) ?? mission;

    if (effectiveStatus === "done") {
      itemsDone++;
      noProgress = 0;
    } else if (effectiveStatus === "blocked_needs_human") {
      noProgress = 0; // parking an item resolves it out of the retry pool — that's progress
    } else {
      noProgress++;
    }
    await deps.notifier?.notify({ type: "item_finished", missionId, item: finished, status: effectiveStatus });
  };

  while (true) {
    // Kill switch / external status change: anything but `running` halts here.
    // Route through stop() (not a bare return) so the human who clicked Stop still
    // gets the morning digest (M3 Trin 6) — the prime "what happened?" moment. stop()
    // re-writes the same status (a no-op) and delivers digest + stopped via the Notifier.
    mission = (await backlog.getMission(missionId)) ?? mission;
    if (mission.status !== "running") {
      return stop(mission.status, "stopped");
    }

    // ── governors ──
    const gov = deps.governors ?? {};
    if (gov.maxIterations != null && iterations >= gov.maxIterations) {
      return stop("stopped", "max-iterations");
    }
    const budget = gov.tokenBudget ?? mission.budget;
    if (budget != null && mission.spentTokens >= budget) {
      return stop("stopped", "budget");
    }
    const deadline = gov.deadline ?? mission.deadline;
    if (deadline && deps.clock && deps.clock.now() >= Date.parse(deadline)) {
      return stop("stopped", "deadline");
    }
    if (noProgress >= noProgressLimit) {
      return stop("stopped", "no-progress");
    }

    // ── pick a batch of actionable items (high-risk parked before execution) ──
    const concurrency = Math.max(1, gov.concurrency ?? 1);
    const batch = await pickBatch(concurrency);
    if (batch.length === 0) {
      const items = await backlog.listItems(missionId);
      const pending = items.some((i) => i.status === "todo" || i.status === "in_progress");
      const parked = items.some((i) => i.status === "blocked_needs_human");
      if (pending) return stop("blocked", "remaining items blocked on unmet dependencies");
      if (parked) return stop("blocked", "all remaining items need a human");
      return stop("done", "done");
    }

    // Execute + verify + replan IN PARALLEL — each item in its own worktree, so
    // they never share a working tree. Integration is then applied SEQUENTIALLY
    // (next), because every merge + post-merge re-verify mutates the one shared
    // mission branch and must not race.
    const outcomes = await Promise.all(batch.map((it) => runAndReplan(it)));
    for (const outcome of outcomes) await finalize(outcome);
  }
}
