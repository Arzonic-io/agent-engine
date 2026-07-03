"use client";

import Link from "next/link";
import type { MissionSummary } from "@arzonic/agent-client";
import { estCost, MISSION_DOT, relTime, tokenCount } from "../lib/format";

/** The active project's missions — long-running, autonomous, observed (not gated). */
export function ProjectMissions({
  missions,
  costPerMtok = null,
}: {
  missions: MissionSummary[];
  costPerMtok?: number | null;
}) {
  const recent = missions.slice(0, 4);
  if (recent.length === 0) return null;

  // Project-level spend rollup across every mission (not just the shown 4).
  const totalTokens = missions.reduce((sum, m) => sum + (m.spentTokens ?? 0), 0);
  const cost = estCost(totalTokens, costPerMtok);

  return (
    <div className="rise mt-7" style={{ animationDelay: "90ms" }}>
      <div className="mb-2 flex items-baseline justify-between">
        <p className="text-xs uppercase tracking-[0.28em] text-dim">Missioner</p>
        {totalTokens > 0 && (
          <p className="text-[11px] text-dim">
            {missions.length} i alt · <span className="font-mono text-fg/70">{tokenCount(totalTokens)}</span> tokens
            {cost && <span className="text-dim/70"> ≈ {cost}</span>}
          </p>
        )}
      </div>
      <ul className="space-y-0.5">
        {recent.map((m) => (
          <li key={m.id}>
            <Link
              href={`/missions/${m.id}`}
              className="flex items-center gap-2 rounded-field px-3 py-2 transition hover:bg-elev/60"
            >
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${MISSION_DOT[m.status] ?? "bg-dim"} ${
                  m.status === "running" ? "pulse-dot" : ""
                }`}
              />
              <span className="min-w-0 flex-1 truncate text-sm text-fg/90">{m.goal}</span>
              <span className="shrink-0 rounded bg-elev px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-dim">
                {m.status}
              </span>
              <span className="shrink-0 text-[11px] text-dim">{relTime(m.createdAt)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
