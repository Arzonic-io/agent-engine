import type {
  BacklogItem,
  BacklogItemStatus,
  BacklogStore,
  CreateBacklogItemInput,
  Mission,
  MissionStatus,
} from "./mission.js";
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

// ── Notifier seam (Trin 7 wires real transport) ──

export type MissionEvent =
  | { type: "item_started"; missionId: string; item: BacklogItem }
  | { type: "item_finished"; missionId: string; item: BacklogItem; status: BacklogItemStatus }
  | { type: "mission_stopped"; missionId: string; status: MissionStatus; reason: string };

export interface Notifier {
  notify(event: MissionEvent): Promise<void> | void;
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
}

export interface MissionDeps {
  backlog: BacklogStore;
  verifier: Verifier;
  runner: WorkRunner;
  replanner?: Replanner;
  notifier?: Notifier;
  clock?: Clock;
  governors?: MissionGovernors;
  /** Checks the Verifier runs per item. Default ["typecheck", "test"]. */
  checks?: string[];
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

  let mission = await backlog.getMission(missionId);
  if (!mission) {
    return { status: "failed", reason: "not-found", iterations: 0, itemsDone: 0 };
  }

  // Resume hygiene: an item left mid-run by a crash goes back to the queue.
  for (const it of await backlog.listItems(missionId)) {
    if (it.status === "in_progress") await backlog.updateItem(it.id, { status: "todo" });
  }

  let iterations = 0;
  let itemsDone = 0;
  let noProgress = 0;

  const stop = async (status: MissionStatus, reason: string): Promise<MissionOutcome> => {
    await backlog.updateMission(missionId, { status });
    await deps.notifier?.notify({ type: "mission_stopped", missionId, status, reason });
    return { status, reason, iterations, itemsDone };
  };

  while (true) {
    // Kill switch / external status change: anything but `running` halts here.
    mission = (await backlog.getMission(missionId)) ?? mission;
    if (mission.status !== "running") {
      return { status: mission.status, reason: "stopped", iterations, itemsDone };
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

    // ── pick the next actionable item ──
    const item = await backlog.nextActionable(missionId);
    if (!item) {
      const items = await backlog.listItems(missionId);
      const pending = items.some((i) => i.status === "todo" || i.status === "in_progress");
      const parked = items.some((i) => i.status === "blocked_needs_human");
      if (pending) return stop("blocked", "remaining items blocked on unmet dependencies");
      if (parked) return stop("blocked", "all remaining items need a human");
      return stop("done", "done");
    }

    iterations++;
    await backlog.updateItem(item.id, { status: "in_progress" });
    await deps.notifier?.notify({ type: "item_started", missionId, item });

    // ── execute → verify → replan ──
    const result = await runner.run(
      { id: item.id, title: item.title, detail: item.detail, context: missionContext(mission) },
      deps.signal,
    );
    await backlog.updateItem(item.id, { runId: result.runId });

    const report = await verifier.run(checks);
    const decision = await replanner.replan({ mission, item, result, verification: report });

    const finished =
      (await backlog.updateItem(item.id, {
        status: decision.itemStatus,
        verification: summarizeVerification(checks, report),
      })) ?? item;
    for (const f of decision.followUps ?? []) {
      await backlog.createItem({ ...f, missionId });
    }

    mission =
      (await backlog.updateMission(missionId, {
        spentTokens: mission.spentTokens + result.tokensUsed + (decision.tokensUsed ?? 0),
      })) ?? mission;

    if (decision.itemStatus === "done") {
      itemsDone++;
      noProgress = 0;
    } else {
      noProgress++;
    }
    await deps.notifier?.notify({
      type: "item_finished",
      missionId,
      item: finished,
      status: decision.itemStatus,
    });
  }
}
