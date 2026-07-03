import type { RepoInfo } from "@arzonic/agent-client";

/** Dot colour per run/task status. */
export const STATUS_DOT: Record<string, string> = {
  running: "bg-builder",
  awaiting_human: "bg-warning",
  accepted: "bg-success",
  rejected: "bg-error",
  failed: "bg-error",
};

/** Dot colour per mission status. */
export const MISSION_DOT: Record<string, string> = {
  running: "bg-builder",
  paused: "bg-warning",
  blocked: "bg-warning",
  done: "bg-success",
  failed: "bg-error",
  stopped: "bg-dim",
};

/** Dot colour + Danish label per backlog-item status. */
export const ITEM_STATUS: Record<string, { dot: string; label: string }> = {
  todo: { dot: "bg-dim", label: "Kø" },
  in_progress: { dot: "bg-builder", label: "I gang" },
  done: { dot: "bg-success", label: "Færdig" },
  blocked_needs_human: { dot: "bg-warning", label: "Afventer dig" },
  failed: { dot: "bg-error", label: "Fejlet" },
};

/** The standing team a project hands work to. Core runs always; the rest join on team-mode tasks. */
export const TEAM_CORE = [
  { label: "Udvikler", dot: "bg-builder" },
  { label: "Kritiker", dot: "bg-critic" },
];
export const TEAM_EXTRA = [
  { label: "Planlægger", dot: "bg-analyst" },
  { label: "Arkitekt", dot: "bg-lead" },
  { label: "Tester", dot: "bg-success" },
  { label: "Lead", dot: "bg-human" },
  { label: "Koordinator", dot: "bg-warning" },
];
export const TEAM_ALL = [...TEAM_CORE, ...TEAM_EXTRA];

/** Short, human label for a repo path — its discovered name, else the folder. */
export function repoLabel(path: string, repos: RepoInfo[]): string {
  return repos.find((r) => r.path === path)?.name ?? path.split("/").filter(Boolean).pop() ?? path;
}

/** Compact token count for dense readouts ("1.2M", "34k", "812"). */
export function tokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return `${n}`;
}

/**
 * Estimated USD cost from a total token count and a blended $/1M-token rate.
 * Returns null when no rate is configured (the UI then shows tokens only). This
 * is approximate: we track total tokens, not the input/output split real pricing
 * uses — so it's always shown as "≈ $X", never an exact bill.
 */
export function estCost(tokens: number, ratePerMtok: number | null): string | null {
  if (ratePerMtok == null || ratePerMtok <= 0) return null;
  const usd = (tokens / 1_000_000) * ratePerMtok;
  if (usd === 0) return "$0.00";
  return usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;
}

/** Danish relative time, verbose ("5 min siden"). */
export function relTime(ts: string | null): string {
  if (!ts) return "aldrig";
  const m = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
  if (m < 1) return "lige nu";
  if (m < 60) return `${m} min siden`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} t siden`;
  return `${Math.floor(h / 24)} d siden`;
}

/** Danish relative time, compact ("5m") — for dense lists like the sidebar. */
export function relShort(ts: string): string {
  const m = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
  if (m < 1) return "nu";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}t`;
  return `${Math.floor(h / 24)}d`;
}
