"use client";

import Link from "next/link";
import { use, useEffect, useRef, useState } from "react";
import {
  LuArrowLeft,
  LuCheck,
  LuChevronDown,
  LuChevronRight,
  LuCircleStop,
  LuCompass,
  LuFileDiff,
  LuGitPullRequest,
  LuActivity,
  LuSave,
  LuTriangleAlert,
  LuUsers,
  LuX,
} from "react-icons/lu";
import type {
  ApiBacklogItem,
  ApiDiff,
  MissionDetail,
  MissionStreamEvent,
} from "@arzonic/agent-client";
import { estCost, ITEM_STATUS, MISSION_DOT } from "../../lib/format";
import { ErrorState, LoadingState } from "../../components/StateViews";
import { MissionLiveFeed } from "../../components/MissionLiveFeed";
import {
  TEAM_ROLES,
  TeamModelPicker,
  roleModelsToSelection,
  selectionToRoleModels,
  type TeamSelection,
} from "../../components/TeamModelPicker";

/** Order the board shows status groups in — human-needed first. */
const GROUP_ORDER: { key: ApiBacklogItem["status"]; label: string }[] = [
  { key: "blocked_needs_human", label: "Afventer dig" },
  { key: "in_progress", label: "I gang" },
  { key: "todo", label: "Kø" },
  { key: "done", label: "Færdig" },
  { key: "failed", label: "Fejlet" },
];

/** Human text for the controller's machine-readable stop reason. */
const STOP_REASON_TEXT: Record<string, string> = {
  done: "Missionen er færdig — målet er nået.",
  budget: "Stoppet: token-budgettet er brugt op.",
  deadline: "Stoppet: deadline blev nået.",
  "max-iterations": "Stoppet: iterations-loftet blev nået.",
  "no-progress": "Stoppet: ingen fremskridt i flere runder i træk.",
  stopped: "Stoppet manuelt (kill switch).",
  "remaining items blocked on unmet dependencies":
    "Blokeret: resterende punkter venter på uopfyldte afhængigheder.",
  "all remaining items need a human": "Blokeret: alle resterende punkter afventer din beslutning.",
};

/** Explain a terminal mission's end state; falls back to the raw reason / status. */
function stopReasonText(m: MissionDetail): string {
  const r = m.stopReason ?? "";
  if (STOP_REASON_TEXT[r]) return STOP_REASON_TEXT[r];
  if (r) return `Stoppet: ${r}`;
  // Missions from before stop_reason existed — explain from the status alone.
  const byStatus: Partial<Record<MissionDetail["status"], string>> = {
    done: "Missionen er færdig.",
    failed: "Missionen fejlede.",
    stopped: "Missionen blev stoppet.",
    blocked: "Missionen afventer dig.",
  };
  return byStatus[m.status] ?? m.status;
}

/** Banner tone per terminal status. */
function stopTone(status: MissionDetail["status"]): string {
  if (status === "done") return "border-success/40 bg-success/10 text-success";
  if (status === "blocked") return "border-warning/40 bg-warning/10 text-warning";
  return "border-error/40 bg-error/10 text-error"; // failed | stopped
}

export default function MissionDashboard({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [mission, setMission] = useState<MissionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  // Edit-team-on-a-running-mission state.
  const [teamOpen, setTeamOpen] = useState(false);
  const [teamSel, setTeamSel] = useState<TeamSelection>({});
  const [savingTeam, setSavingTeam] = useState(false);
  const [teamErr, setTeamErr] = useState<string | null>(null);
  // Which items have their authored-diff expanded.
  const [openDiffs, setOpenDiffs] = useState<Set<string>>(new Set());
  // Lazily-fetched full patches, keyed by item id — the board snapshot ships only
  // the diff summary (no patch), so we load the patch on first expand and cache it.
  const [patches, setPatches] = useState<Map<string, ApiDiff>>(new Map());
  const [loadingDiffs, setLoadingDiffs] = useState<Set<string>>(new Set());
  // Operator guidance (course-correction).
  const [guidanceText, setGuidanceText] = useState("");
  const [savingGuidance, setSavingGuidance] = useState(false);
  const [guidanceErr, setGuidanceErr] = useState<string | null>(null);
  const guidanceSeeded = useRef(false);
  const esRef = useRef<EventSource | null>(null);
  // Blended $/1M-token rate for an estimated cost readout (null = tokens only) +
  // an optional LangSmith traces deep link (null = tracing off / no URL set).
  const [costPerMtok, setCostPerMtok] = useState<number | null>(null);
  const [traceUrl, setTraceUrl] = useState<string | null>(null);
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/status");
        if (!res.ok) return;
        const s = (await res.json()) as { costPerMtok?: number | null; traceUrl?: string | null };
        setCostPerMtok(s.costPerMtok ?? null);
        setTraceUrl(s.traceUrl ?? null);
      } catch {
        /* best-effort — cost + trace readouts just stay off */
      }
    })();
  }, []);

  // Seed the guidance box from the mission once (SSE snapshots must not clobber typing).
  useEffect(() => {
    if (mission && !guidanceSeeded.current) {
      setGuidanceText(mission.guidance ?? "");
      guidanceSeeded.current = true;
    }
  }, [mission]);

  const toggleDiff = (itemId: string) => {
    const willOpen = !openDiffs.has(itemId);
    setOpenDiffs((prev) => {
      const next = new Set(prev);
      next.has(itemId) ? next.delete(itemId) : next.add(itemId);
      return next;
    });
    if (willOpen) void loadDiff(itemId);
  };

  // Fetch an item's full patch once and cache it; the board snapshot omits it.
  async function loadDiff(itemId: string) {
    if (patches.has(itemId)) return;
    setLoadingDiffs((prev) => new Set(prev).add(itemId));
    try {
      const res = await fetch(`/api/missions/${id}/items/${itemId}/diff`);
      if (res.ok) {
        const diff = (await res.json()) as ApiDiff | null;
        if (diff) setPatches((prev) => new Map(prev).set(itemId, diff));
      }
    } catch {
      /* leave uncached so re-expanding retries */
    } finally {
      setLoadingDiffs((prev) => {
        const next = new Set(prev);
        next.delete(itemId);
        return next;
      });
    }
  }

  // Initial load + live snapshot stream.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch(`/api/missions/${id}`);
        if (res.ok && alive) setMission((await res.json()) as MissionDetail);
        else if (!res.ok) setError(await res.text());
      } catch {
        /* stream will retry */
      }
    })();

    const es = new EventSource(`/api/missions/${id}/stream`);
    esRef.current = es;
    es.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data) as MissionStreamEvent;
        if (ev.type === "snapshot") {
          setMission({ ...ev.mission, items: ev.items, digest: ev.digest });
        }
      } catch {
        /* ignore malformed frame */
      }
    };
    // Stream closes when the mission goes terminal; that's expected.
    es.onerror = () => es.close();
    return () => {
      alive = false;
      es.close();
    };
  }, [id]);

  async function decide(itemId: string, decision: "approve" | "reject") {
    setDeciding(itemId);
    try {
      await fetch(`/api/missions/${id}/items/${itemId}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      // Optimistic: reflect immediately; the next snapshot confirms.
      setMission((m) =>
        m
          ? {
              ...m,
              items: m.items.map((it) =>
                it.id === itemId
                  ? { ...it, status: decision === "approve" ? "todo" : "failed" }
                  : it,
              ),
            }
          : m,
      );
    } catch {
      /* best-effort */
    } finally {
      setDeciding(null);
    }
  }

  async function stop() {
    setStopping(true);
    try {
      await fetch(`/api/missions/${id}/stop`, { method: "POST" });
    } catch {
      /* best-effort */
    } finally {
      setStopping(false);
    }
  }

  function openTeam() {
    setTeamSel(roleModelsToSelection(mission?.roleModels));
    setTeamErr(null);
    setTeamOpen(true);
  }

  async function saveTeam() {
    setSavingTeam(true);
    setTeamErr(null);
    try {
      const res = await fetch(`/api/missions/${id}/role-models`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roleModels: selectionToRoleModels(teamSel) }),
      });
      if (!res.ok) throw new Error(await res.text());
      setMission((await res.json()) as MissionDetail);
      setTeamOpen(false);
    } catch (e) {
      setTeamErr(e instanceof Error ? e.message : "Kunne ikke gemme teamet");
    } finally {
      setSavingTeam(false);
    }
  }

  async function saveGuidance() {
    setSavingGuidance(true);
    setGuidanceErr(null);
    try {
      const res = await fetch(`/api/missions/${id}/guidance`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ guidance: guidanceText.trim() || null }),
      });
      if (!res.ok) throw new Error(await res.text());
      setMission((await res.json()) as MissionDetail);
    } catch (e) {
      setGuidanceErr(e instanceof Error ? e.message : "Kunne ikke sende styringen");
    } finally {
      setSavingGuidance(false);
    }
  }

  if (error) {
    return (
      <ErrorState
        title="Kunne ikke indlæse missionen"
        hint={error}
        action={
          <Link href="/" className="btn btn-ghost btn-sm gap-1 text-dim">
            <LuArrowLeft className="h-4 w-4" /> Til projektet
          </Link>
        }
      />
    );
  }
  if (!mission) {
    return <LoadingState label="Indlæser mission…" />;
  }

  const active = mission.status === "running" || mission.status === "paused";
  const burn = mission.budget ? Math.min(100, (mission.spentTokens / mission.budget) * 100) : null;
  const estCostText = estCost(mission.spentTokens, costPerMtok);
  const d = mission.digest;

  return (
    <div className="h-full overflow-y-auto px-6 sm:px-8">
      <div className="mx-auto w-full max-w-4xl pb-20 pt-[5vh]">
        <Link href="/" className="mb-4 inline-flex items-center gap-1 text-xs text-dim hover:text-fg">
          <LuArrowLeft className="h-3.5 w-3.5" /> Til projektet
        </Link>

        {/* header */}
        <div className="rise rounded-box border border-line bg-panel p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="mb-1 flex items-center gap-2">
                <span
                  className={`h-2.5 w-2.5 rounded-full ${MISSION_DOT[mission.status] ?? "bg-dim"} ${
                    mission.status === "running" ? "pulse-dot" : ""
                  }`}
                />
                <span className="text-xs uppercase tracking-[0.28em] text-dim">{mission.status}</span>
              </div>
              <h1 className="display text-2xl font-extrabold leading-snug tracking-tight">
                {mission.goal}
              </h1>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {traceUrl && (
                <a
                  href={traceUrl}
                  target="_blank"
                  rel="noreferrer"
                  title="Åbn LangSmith-traces for at se agenternes ræsonnement"
                  className="btn btn-sm gap-1 border-line bg-elev text-dim hover:text-fg"
                >
                  <LuActivity className="h-4 w-4" /> Traces
                </a>
              )}
              {mission.prUrl && (
                <a
                  href={mission.prUrl}
                  target="_blank"
                  rel="noreferrer"
                  title={mission.publishNote ?? undefined}
                  className="btn btn-sm gap-1 border-line bg-elev text-builder hover:border-builder/50"
                >
                  <LuGitPullRequest className="h-4 w-4" /> Se PR
                </a>
              )}
              {active && (
                <>
                  <button
                    onClick={openTeam}
                    className="btn btn-sm gap-1 border-line bg-elev text-dim hover:text-fg"
                  >
                    <LuUsers className="h-4 w-4" /> Team
                  </button>
                  <button
                    onClick={() => void stop()}
                    disabled={stopping}
                    className="btn btn-sm gap-1 border-line bg-elev text-error hover:border-error/50"
                  >
                    <LuCircleStop className="h-4 w-4" /> Stop
                  </button>
                </>
              )}
            </div>
          </div>

          {/* terminal end-state: WHY it ended + how publishing went (M3 morgen-review) */}
          {!active && (
            <div
              className={`mt-3 flex items-start gap-2 rounded-field border px-3 py-2 text-sm ${stopTone(mission.status)}`}
            >
              {mission.status === "done" ? (
                <LuCheck className="mt-0.5 h-4 w-4 shrink-0" />
              ) : mission.status === "blocked" ? (
                <LuTriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              ) : (
                <LuCircleStop className="mt-0.5 h-4 w-4 shrink-0" />
              )}
              <div className="min-w-0">
                <p>{stopReasonText(mission)}</p>
                {!mission.prUrl && mission.publishNote && (
                  <p className="mt-0.5 text-xs opacity-75">Publicering: {mission.publishNote}</p>
                )}
              </div>
            </div>
          )}

          {/* budget burn */}
          <div className="mt-4">
            <div className="flex items-center justify-between text-xs text-dim">
              <span>Forbrug</span>
              <span className="font-mono text-fg/80">
                {mission.spentTokens.toLocaleString("da-DK")}
                {mission.budget ? ` / ${mission.budget.toLocaleString("da-DK")}` : ""} tokens
                {estCostText && <span className="text-dim/80"> · ≈ {estCostText}</span>}
              </span>
            </div>
            {burn !== null && (
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-elev">
                <div
                  className={`h-full rounded-full ${burn > 90 ? "bg-error" : burn > 80 ? "bg-warning" : "bg-builder"}`}
                  style={{ width: `${burn}%` }}
                />
              </div>
            )}
            {/* Live budget warning while running — before it hard-stops at 100%. */}
            {active && burn !== null && burn >= 80 && (
              <p
                className={`mt-1.5 flex items-center gap-1.5 text-[11px] ${burn >= 100 ? "text-error" : "text-warning"}`}
              >
                <LuTriangleAlert className="h-3 w-3 shrink-0" />
                {burn >= 100
                  ? "Budgettet er brugt op — missionen stopper ved næste checkpoint."
                  : `Budgettet er ${Math.round(burn)}% brugt.`}
              </p>
            )}
          </div>

          {/* digest counters */}
          <div className="mt-4 flex flex-wrap gap-2 text-xs">
            <Counter label="færdige" value={d.done.length} tone="text-success" />
            <Counter label="afventer dig" value={d.parked.length} tone="text-warning" />
            <Counter label="i kø / gang" value={d.pending} tone="text-fg/70" />
            <Counter label="fejlet" value={d.failed.length} tone="text-error" />
          </div>
          {mission.acceptanceCriteria.length > 0 && (
            <p className="mt-3 text-xs text-dim">
              <span className="text-fg/60">Accept:</span> {mission.acceptanceCriteria.join(" · ")}
            </p>
          )}
          {mission.checks && mission.checks.length > 0 && (
            <p className="mt-1 text-xs text-dim">
              <span className="text-fg/60">Checks:</span> {mission.checks.join(" · ")}
            </p>
          )}

          {/* the team assigned to THIS mission — pinned roles with their model;
              everything else runs the global default from Settings */}
          <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
            <span className="inline-flex items-center gap-1 text-dim">
              <LuUsers className="h-3.5 w-3.5" /> Team:
            </span>
            {TEAM_ROLES.filter((r) => mission.roleModels?.[r.key]).map((r) => {
              const spec = mission.roleModels[r.key]!;
              return (
                <span
                  key={r.key}
                  className="inline-flex items-center gap-1.5 rounded-full border border-line bg-elev px-2 py-0.5"
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${r.dot}`} />
                  <span className="text-fg/90">{r.label}</span>
                  <span className="font-mono text-[10px] text-dim">
                    {spec.model ?? spec.provider}
                  </span>
                </span>
              );
            })}
            {Object.keys(mission.roleModels ?? {}).length === 0 && (
              <span className="text-dim">Standard-teamet (Indstillinger)</span>
            )}
          </div>

          {/* Digest foresight: the next high-risk work coming up (M3 Trin 6). */}
          {d.nextHighRisk.length > 0 && (
            <p className="mt-3 flex items-start gap-1.5 text-xs text-warning/90">
              <LuTriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                <span className="text-fg/60">Næste høj-risiko:</span> {d.nextHighRisk.join(" · ")}
              </span>
            </p>
          )}

          {/* Operator guidance — course-correct a running mission (M3 Trin 6). */}
          {active && (
            <div className="mt-4 rounded-field border border-line bg-elev/40 p-3">
              <div className="mb-1.5 flex items-center gap-1.5 text-xs text-dim">
                <LuCompass className="h-3.5 w-3.5" /> Styring · kurskorrektion
              </div>
              <textarea
                value={guidanceText}
                onChange={(e) => setGuidanceText(e.target.value)}
                rows={2}
                placeholder="Send fri-tekst til missionen — fx 'prioritér fejlhåndtering' eller 'spring deploy over'. Flyder ind i næste planlægnings-runde."
                className="textarea textarea-sm w-full resize-none border-line bg-elev text-sm"
              />
              <div className="mt-2 flex items-center gap-3">
                <button
                  onClick={() => void saveGuidance()}
                  disabled={savingGuidance}
                  className="btn btn-sm gap-2 border-line bg-elev text-fg normal-case hover:border-builder/50"
                >
                  {savingGuidance ? (
                    <>
                      <span className="loading loading-spinner loading-xs" /> Sender…
                    </>
                  ) : (
                    <>
                      <LuCompass className="h-4 w-4" /> Send styring
                    </>
                  )}
                </button>
                {mission.guidance ? (
                  <span className="text-xs text-builder">Aktiv styring ✓</span>
                ) : (
                  <span className="text-xs text-dim">Ingen aktiv styring</span>
                )}
                {guidanceErr && <span className="text-xs text-error">{guidanceErr}</span>}
              </div>
            </div>
          )}
        </div>

        {/* live feed — what each agent is doing right now (Claude Code-style) */}
        <MissionLiveFeed
          missionId={id}
          items={mission.items}
          running={mission.status === "running"}
        />

        {/* backlog board */}
        <div className="mt-6 space-y-5">
          {GROUP_ORDER.map(({ key, label }) => {
            const group = mission.items.filter((it) => it.status === key);
            if (group.length === 0) return null;
            return (
              <section key={key}>
                <h2 className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-[0.28em] text-dim">
                  <span className={`h-1.5 w-1.5 rounded-full ${ITEM_STATUS[key]?.dot ?? "bg-dim"}`} />
                  {label} <span className="text-fg/40">{group.length}</span>
                </h2>
                <ul className="space-y-2">
                  {group.map((it) => (
                    <li
                      key={it.id}
                      className="rounded-box border border-line bg-panel px-4 py-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm text-fg/90">{it.title}</span>
                            {it.risk === "high" && (
                              <span className="rounded-full bg-warning/15 px-1.5 py-0.5 text-[10px] font-semibold text-warning">
                                høj risiko
                              </span>
                            )}
                          </div>
                          {it.detail && (
                            <p className="mt-1 line-clamp-2 text-xs text-dim">{it.detail}</p>
                          )}
                          {it.verification && !it.verification.passed && (
                            <p className="mt-1 truncate font-mono text-[11px] text-error/80">
                              {it.verification.check}: fejlede
                            </p>
                          )}
                        </div>
                        {it.status === "blocked_needs_human" && (
                          <div className="flex shrink-0 gap-1.5">
                            <button
                              onClick={() => void decide(it.id, "approve")}
                              disabled={deciding === it.id}
                              className="btn btn-xs gap-1 border-line bg-elev text-success hover:border-success/50"
                            >
                              <LuCheck className="h-3.5 w-3.5" /> Godkend
                            </button>
                            <button
                              onClick={() => void decide(it.id, "reject")}
                              disabled={deciding === it.id}
                              className="btn btn-xs gap-1 border-line bg-elev text-error hover:border-error/50"
                            >
                              <LuX className="h-3.5 w-3.5" /> Afvis
                            </button>
                          </div>
                        )}
                      </div>
                      {it.diff && it.diff.files.length > 0 && (
                        <DiffView
                          diff={it.diff}
                          patch={patches.get(it.id)?.patch ?? ""}
                          loading={loadingDiffs.has(it.id)}
                          open={openDiffs.has(it.id)}
                          onToggle={() => toggleDiff(it.id)}
                        />
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      </div>

      {/* Edit-team-on-a-running-mission modal. */}
      {teamOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60" onClick={() => setTeamOpen(false)} />
          <div className="relative w-full max-w-xl rounded-box border border-line bg-panel p-5 shadow-2xl shadow-black/40">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-base font-bold">
                <LuUsers className="h-4 w-4 text-dim" /> Missionens team
              </h2>
              <button
                onClick={() => setTeamOpen(false)}
                className="btn btn-ghost btn-sm btn-square"
                aria-label="Luk"
              >
                <LuX className="h-4 w-4" />
              </button>
            </div>
            <p className="mb-3 text-xs leading-relaxed text-dim">
              Vælg provider og model pr. stilling for denne mission. Ændringer træder i kraft ved
              næste planlægnings-runde — ikke det punkt der kører lige nu.
            </p>
            <TeamModelPicker roles={TEAM_ROLES} value={teamSel} onChange={setTeamSel} />
            <div className="mt-4 flex items-center gap-3">
              <button
                onClick={() => void saveTeam()}
                disabled={savingTeam}
                className="btn btn-primary btn-sm gap-2 normal-case"
              >
                {savingTeam ? (
                  <>
                    <span className="loading loading-spinner loading-xs" /> Gemmer…
                  </>
                ) : (
                  <>
                    <LuSave className="h-4 w-4" /> Gem team
                  </>
                )}
              </button>
              <button
                onClick={() => setTeamOpen(false)}
                className="btn btn-ghost btn-sm text-dim normal-case"
              >
                Annuller
              </button>
              {teamErr && <span className="text-xs text-error">{teamErr}</span>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Tailwind colour for a changed-file status letter. */
const DIFF_STATUS: Record<ApiDiff["files"][number]["status"], { tone: string; mark: string }> = {
  added: { tone: "text-success", mark: "A" },
  modified: { tone: "text-warning", mark: "M" },
  deleted: { tone: "text-error", mark: "D" },
  renamed: { tone: "text-fg/60", mark: "R" },
};

/**
 * Collapsible view of an item's authored diff — file list (from the board
 * summary) + the lazily-fetched unified patch. The patch arrives via `patch`
 * once the human expands the item; `loading` covers the in-flight fetch.
 */
function DiffView({
  diff,
  patch,
  loading,
  open,
  onToggle,
}: {
  diff: ApiDiff;
  patch: string;
  loading: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="mt-2 border-t border-line pt-2">
      <button
        onClick={onToggle}
        className="flex items-center gap-1.5 text-[11px] text-dim transition hover:text-fg"
      >
        {open ? <LuChevronDown className="h-3.5 w-3.5" /> : <LuChevronRight className="h-3.5 w-3.5" />}
        <LuFileDiff className="h-3.5 w-3.5" />
        <span className="text-fg/70">
          {diff.files.length} {diff.files.length === 1 ? "fil" : "filer"}
        </span>
        <span className="font-mono text-success">+{diff.additions}</span>
        <span className="font-mono text-error">−{diff.deletions}</span>
        <span className="text-dim/60">{open ? "skjul ændring" : "se ændring"}</span>
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <ul className="space-y-0.5">
            {diff.files.map((f) => {
              const s = DIFF_STATUS[f.status];
              return (
                <li key={f.path} className="flex items-center gap-2 text-[11px]">
                  <span className={`font-mono font-bold ${s.tone}`}>{s.mark}</span>
                  <span className="truncate font-mono text-fg/80">{f.path}</span>
                  <span className="ml-auto shrink-0 font-mono text-dim">
                    <span className="text-success">+{f.additions}</span>{" "}
                    <span className="text-error">−{f.deletions}</span>
                  </span>
                </li>
              );
            })}
          </ul>
          {loading ? (
            <p className="flex items-center gap-1.5 text-[11px] text-dim">
              <span className="loading loading-spinner loading-xs" /> indlæser…
            </p>
          ) : (
            patch.trim() && (
              <pre className="max-h-80 overflow-auto rounded-field border border-line bg-elev/60 p-2 text-[11px] leading-relaxed">
                <code>
                  {patch.split("\n").map((line, i) => (
                    <span key={i} className={`block ${patchLineTone(line)}`}>
                      {line || " "}
                    </span>
                  ))}
                </code>
              </pre>
            )
          )}
          {!loading && diff.truncated && (
            <p className="text-[10px] text-dim/70">… diffen er forkortet (for stor til at vise fuldt ud).</p>
          )}
        </div>
      )}
    </div>
  );
}

/** Colour a unified-diff line by its leading marker. */
function patchLineTone(line: string): string {
  if (line.startsWith("@@")) return "text-analyst";
  if (line.startsWith("+++") || line.startsWith("---")) return "text-dim";
  if (line.startsWith("+")) return "text-success";
  if (line.startsWith("-")) return "text-error";
  if (line.startsWith("diff ") || line.startsWith("index ")) return "text-dim/60";
  return "text-fg/70";
}

function Counter({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-field border border-line bg-elev px-2.5 py-1">
      <span className={`font-mono font-semibold ${tone}`}>{value}</span>
      <span className="text-dim">{label}</span>
    </span>
  );
}
