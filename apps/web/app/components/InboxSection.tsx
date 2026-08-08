"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { LuArrowRight, LuGavel, LuRocket, LuTriangleAlert } from "react-icons/lu";
import type { Inbox } from "@arzonic/agent-client";
import { relShort } from "../lib/format";

/** How often the inbox re-checks while the tab is visible. */
const POLL_MS = 8000;

/**
 * "Venter på dig" — every decision the agents are blocked on, across every
 * project, at the top of the front page.
 *
 * The work itself was always visible; the *decisions* were not. A paused run
 * only announced itself inside its own run page and a parked mission item only
 * inside its mission, so the one question an operator opens this app to ask —
 * what needs me right now? — had no screen that answered it.
 */
export function InboxSection() {
  const [inbox, setInbox] = useState<Inbox | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      // A hidden tab can't be read; polling it just burns queries.
      if (document.hidden) return;
      try {
        const res = await fetch("/api/inbox");
        if (res.ok && alive) setInbox((await res.json()) as Inbox);
      } catch {
        /* best-effort — the section simply keeps its last state */
      }
    };
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    document.addEventListener("visibilitychange", load);
    return () => {
      alive = false;
      clearInterval(t);
      document.removeEventListener("visibilitychange", load);
    };
  }, []);

  const total = (inbox?.tasks.length ?? 0) + (inbox?.items.length ?? 0);
  if (!inbox || total === 0) return null;

  return (
    <section className="rise mb-8">
      <div className="mb-2.5 flex items-center gap-2">
        <span className="pulse-dot inline-block h-2 w-2 rounded-full bg-warning" />
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.25em] text-warning">
          Venter på dig · {total}
        </h2>
      </div>

      <div className="space-y-2">
        {inbox.tasks.map((t) => (
          <Link
            key={t.id}
            href={`/runs/${t.id}`}
            className="group flex items-center gap-3 rounded-box border border-warning/30 bg-warning/[0.04] px-4 py-3 transition hover:border-warning/60"
          >
            <LuGavel className="h-4 w-4 shrink-0 text-warning" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-fg/90">{t.task}</p>
              <p className="mt-0.5 text-[11px] text-dim">
                {t.projectName} · opgave ved gaten · {relShort(t.createdAt)}
              </p>
            </div>
            <span className="shrink-0 text-xs text-dim transition group-hover:text-fg">
              Afgør <LuArrowRight className="inline h-3.5 w-3.5" />
            </span>
          </Link>
        ))}

        {inbox.items.map((it) => (
          <Link
            key={it.itemId}
            href={`/missions/${it.missionId}`}
            className="group flex items-center gap-3 rounded-box border border-warning/30 bg-warning/[0.04] px-4 py-3 transition hover:border-warning/60"
          >
            <LuRocket className="h-4 w-4 shrink-0 text-warning" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-fg/90">{it.title}</p>
              <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-dim">
                <span className="truncate">
                  {it.projectName} · mission “{it.missionGoal}” · {relShort(it.updatedAt)}
                </span>
                {it.failedCheck && (
                  <span className="shrink-0 rounded-full bg-error/15 px-1.5 py-0.5 font-mono text-[10px] text-error">
                    {it.failedCheck} fejlede
                  </span>
                )}
                {it.risk === "high" && (
                  <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-warning/15 px-1.5 py-0.5 text-[10px] text-warning">
                    <LuTriangleAlert className="h-3 w-3" /> høj risiko
                  </span>
                )}
              </p>
            </div>
            <span className="shrink-0 text-xs text-dim transition group-hover:text-fg">
              Afgør <LuArrowRight className="inline h-3.5 w-3.5" />
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
