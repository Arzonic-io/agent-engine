import type {
  BacklogItem,
  BacklogStore,
  Mission,
  MissionStatus,
  Risk,
} from "./mission.js";

/**
 * Trin 7 — human policy (§5.5): park-risk, run the rest, never block. High-risk
 * work is parked for an async human decision while the mission keeps moving; a
 * digest summarises what happened. All pure — the controller and the API call
 * into this; no I/O of its own beyond the injected BacklogStore.
 */

/**
 * Static high-risk signals. Conservative by design: over-parking is safe (a
 * human just approves), under-parking is not (the mission does something
 * irreversible unattended). Hosts extend this via `MISSION_HIGH_RISK_PATTERNS`.
 */
export const DEFAULT_HIGH_RISK_PATTERNS = [
  "deploy",
  "production",
  "prod ",
  "release",
  "drop table",
  "truncate",
  "delete",
  "destroy",
  "rm -rf",
  "force push",
  "payment",
  "charge",
  "billing",
  "refund",
  "secret",
  "credential",
  "api key",
  "password",
  "token",
  "migrate",
  "dns",
];

/**
 * Classify an item's risk: the planner's own `high` flag always wins, otherwise
 * match the static patterns against title + detail. Returns `high` or `low`.
 */
export function classifyRisk(
  item: { title: string; detail?: string; risk?: Risk },
  extraPatterns: string[] = [],
): Risk {
  if (item.risk === "high") return "high";
  const hay = `${item.title}\n${item.detail ?? ""}`.toLowerCase();
  const patterns = [...DEFAULT_HIGH_RISK_PATTERNS, ...extraPatterns].map((p) =>
    p.toLowerCase().trim(),
  );
  return patterns.some((p) => p.length > 0 && hay.includes(p)) ? "high" : "low";
}

/**
 * Clear a parked item for execution (async human approval). The human has
 * accepted the risk, so it is marked low-risk — otherwise the loop's pre-run
 * risk gate would just park it again — and set back to `todo` so it becomes
 * actionable on the next iteration.
 */
export function approveParkedItem(
  backlog: BacklogStore,
  itemId: string,
): Promise<BacklogItem | null> {
  return backlog.updateItem(itemId, { status: "todo", risk: "low" });
}

/** Reject a parked item: it will not be worked. */
export function rejectParkedItem(
  backlog: BacklogStore,
  itemId: string,
): Promise<BacklogItem | null> {
  return backlog.updateItem(itemId, { status: "failed" });
}

/**
 * Resume a mission the loop parked only because every remaining item was waiting
 * on a human. When the controller runs out of actionable work and the rest is
 * parked, it calls `stop("blocked", …)` — so the mission sits at `blocked` while
 * the PM2 worker, which scans only `running` missions, ignores it. Approving a
 * parked item re-queues the ITEM but does nothing to the MISSION, so the work
 * would never resume — the "never block the loop" invariant breaks. Flipping
 * `blocked` → `running` lets the worker re-pick it on its next poll.
 *
 * ONLY `blocked` is resurrected: a `stopped` mission was deliberately killed by a
 * human, `paused` was deliberately paused, and `done`/`failed` are terminal — none
 * should silently restart. `running` is already live, so this is a no-op there too.
 * Returns the (possibly updated) mission, or null if it no longer exists.
 */
export function resumeMissionIfBlocked(
  backlog: BacklogStore,
  missionId: string,
): Promise<Mission | null> {
  return backlog.getMission(missionId).then((mission) => {
    if (!mission || mission.status !== "blocked") return mission;
    return backlog.updateMission(missionId, { status: "running" });
  });
}

export interface MissionDigest {
  missionId: string;
  goal: string;
  status: MissionStatus;
  spentTokens: number;
  /** Titles of completed items. */
  done: string[];
  /** Titles parked awaiting a human decision. */
  parked: string[];
  /** Titles that failed outright. */
  failed: string[];
  /** Count of items still queued or in flight. */
  pending: number;
  /** Titles of the items that would run next (actionable, not parked). */
  next: string[];
}

/** Roll a mission + its backlog into the morning-digest shape (§5.5). Pure. */
export function buildDigest(mission: Mission, items: BacklogItem[]): MissionDigest {
  const byStatus = (s: BacklogItem["status"]) =>
    items.filter((i) => i.status === s).map((i) => i.title);
  const doneIds = new Set(items.filter((i) => i.status === "done").map((i) => i.id));
  const next = items
    .filter((i) => i.status === "todo" && i.dependsOn.every((d) => doneIds.has(d)))
    .sort((a, b) => b.priority - a.priority)
    .map((i) => i.title);
  return {
    missionId: mission.id,
    goal: mission.goal,
    status: mission.status,
    spentTokens: mission.spentTokens,
    done: byStatus("done"),
    parked: byStatus("blocked_needs_human"),
    failed: byStatus("failed"),
    pending: items.filter((i) => i.status === "todo" || i.status === "in_progress").length,
    next,
  };
}
