"use client";

import Link from "next/link";
import { use, useEffect, useRef, useState } from "react";
import { LuArrowLeft, LuCheck, LuCircleStop, LuX } from "react-icons/lu";
import type {
  ApiBacklogItem,
  MissionDetail,
  MissionStreamEvent,
} from "@arzonic/agent-client";
import { ITEM_STATUS, MISSION_DOT } from "../../lib/format";

/** Order the board shows status groups in — human-needed first. */
const GROUP_ORDER: { key: ApiBacklogItem["status"]; label: string }[] = [
  { key: "blocked_needs_human", label: "Afventer dig" },
  { key: "in_progress", label: "I gang" },
  { key: "todo", label: "Kø" },
  { key: "done", label: "Færdig" },
  { key: "failed", label: "Fejlet" },
];

export default function MissionDashboard({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [mission, setMission] = useState<MissionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const esRef = useRef<EventSource | null>(null);

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

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <p className="text-sm text-error">{error}</p>
        <Link href="/missions" className="btn btn-ghost btn-sm gap-1 text-dim">
          <LuArrowLeft className="h-4 w-4" /> Tilbage
        </Link>
      </div>
    );
  }
  if (!mission) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="loading loading-spinner loading-md text-dim" />
      </div>
    );
  }

  const active = mission.status === "running" || mission.status === "paused";
  const burn = mission.budget ? Math.min(100, (mission.spentTokens / mission.budget) * 100) : null;
  const d = mission.digest;

  return (
    <div className="h-full overflow-y-auto px-6 sm:px-8">
      <div className="mx-auto w-full max-w-4xl pb-20 pt-[5vh]">
        <Link href="/missions" className="mb-4 inline-flex items-center gap-1 text-xs text-dim hover:text-fg">
          <LuArrowLeft className="h-3.5 w-3.5" /> Alle missioner
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
            {active && (
              <button
                onClick={() => void stop()}
                disabled={stopping}
                className="btn btn-sm gap-1 border-line bg-elev text-error hover:border-error/50"
              >
                <LuCircleStop className="h-4 w-4" /> Stop
              </button>
            )}
          </div>

          {/* budget burn */}
          <div className="mt-4">
            <div className="flex items-center justify-between text-xs text-dim">
              <span>Forbrug</span>
              <span className="font-mono text-fg/80">
                {mission.spentTokens.toLocaleString("da-DK")}
                {mission.budget ? ` / ${mission.budget.toLocaleString("da-DK")}` : ""} tokens
              </span>
            </div>
            {burn !== null && (
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-elev">
                <div
                  className={`h-full rounded-full ${burn > 90 ? "bg-error" : "bg-builder"}`}
                  style={{ width: `${burn}%` }}
                />
              </div>
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
        </div>

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
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Counter({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-field border border-line bg-elev px-2.5 py-1">
      <span className={`font-mono font-semibold ${tone}`}>{value}</span>
      <span className="text-dim">{label}</span>
    </span>
  );
}
