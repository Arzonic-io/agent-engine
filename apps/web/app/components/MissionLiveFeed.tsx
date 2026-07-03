"use client";

import { useEffect, useRef, useState } from "react";
import { LuActivity } from "react-icons/lu";
import type { ApiBacklogItem, MissionItemActivity } from "@arzonic/agent-client";

/**
 * Live feed for a RUNNING mission — the Claude Code-style "what is each agent
 * doing right now" view. One card per in-progress item: the pipeline the item
 * moves through (Udvikler → Kritiker → verifikation → merge), the recent agent
 * messages from its checkpointed run, and a shimmering "…arbejder" line for the
 * step in flight. Polls the activity endpoint per item (the worker checkpoints
 * every graph step to the shared Postgres, so this reads live progress without
 * touching the worker). Between batches — when nothing is in progress — the
 * mission is planning/verifying/merging, shown as a single coordinator line.
 */

/** How an agent name renders in the feed — label + the roster's role colour. */
const AGENT_META: Record<string, { label: string; dot: string }> = {
  implementer: { label: "Udvikler", dot: "bg-builder" },
  builder: { label: "Udvikler", dot: "bg-builder" },
  worker: { label: "Udvikler", dot: "bg-builder" },
  critic: { label: "Kritiker", dot: "bg-critic" },
  architect: { label: "Arkitekt", dot: "bg-lead" },
  lead: { label: "Lead", dot: "bg-human" },
  analyst: { label: "Analytiker", dot: "bg-analyst" },
  human: { label: "Dig", dot: "bg-human" },
  system: { label: "System", dot: "bg-dim" },
};
const agentMeta = (agent: string | null | undefined) =>
  (agent && AGENT_META[agent]) || { label: agent || "Agent", dot: "bg-dim" };

/**
 * The stages one item flows through. Only the graph stages (Udvikler/Kritiker)
 * are observable live via messages; verifikation + merge happen right after in
 * the controller and resolve into the item's final status within seconds.
 */
const PIPELINE = [
  { key: "implementer", label: "Udvikler", dot: "bg-builder" },
  { key: "critic", label: "Kritiker", dot: "bg-critic" },
  { key: "verify", label: "Verifikation", dot: "bg-success" },
  { key: "merge", label: "Merge", dot: "bg-human" },
] as const;

/** Map the latest agent to the item's current pipeline stage. */
function stageIndex(agent: string | null): number {
  if (agent === "critic") return 1;
  return 0; // implementer/builder/worker — or not started yet
}

const POLL_MS = 2500;

/** One in-progress item's live card: pipeline + message tail + working-line. */
function ItemFeed({ missionId, item }: { missionId: string; item: ApiBacklogItem }) {
  const [activity, setActivity] = useState<MissionItemActivity | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`/api/missions/${missionId}/items/${item.id}/activity`);
        if (res.ok && alive) setActivity((await res.json()) as MissionItemActivity);
      } catch {
        /* best-effort — the next tick retries */
      }
    };
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [missionId, item.id]);

  // Keep the newest step in view as the feed grows.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [activity?.messages.length]);

  const current = stageIndex(activity?.agent ?? null);
  const working = agentMeta(activity?.agent ?? "implementer");
  const messages = activity?.messages ?? [];

  return (
    <div className="rise rounded-box border border-line bg-panel px-4 py-3">
      {/* which item + where it is in the pipeline */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 truncate text-sm text-fg/90">{item.title}</span>
        <div className="flex shrink-0 items-center gap-1 text-[10px]">
          {PIPELINE.map((s, i) => (
            <span key={s.key} className="flex items-center gap-1">
              {i > 0 && <span className="text-dim/40">→</span>}
              <span
                className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 transition ${
                  i === current
                    ? "bg-elev text-fg"
                    : i < current
                      ? "text-dim"
                      : "text-dim/40"
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${i === current ? `${s.dot} pulse-dot` : i < current ? s.dot : "bg-dim/40"}`}
                />
                {s.label}
              </span>
            </span>
          ))}
        </div>
      </div>

      {/* the agents' recent steps — newest at the bottom, like a terminal */}
      {messages.length > 0 && (
        <div ref={scrollRef} className="mt-2 max-h-44 space-y-1.5 overflow-y-auto border-t border-line pt-2">
          {messages.map((m, i) => {
            const meta = agentMeta(m.agent);
            return (
              <div key={i} className="flex items-start gap-2 text-xs">
                <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${meta.dot}`} />
                <span className="w-16 shrink-0 text-dim">{meta.label}</span>
                <span className="line-clamp-2 min-w-0 break-words text-fg/75">{m.content}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* the step in flight */}
      <div className="mt-2 flex items-center gap-2 text-xs">
        <span className={`h-1.5 w-1.5 rounded-full ${working.dot} pulse-dot`} />
        <span className="skeleton skeleton-text">
          {working.label} arbejder{activity?.round ? ` · runde ${activity.round}` : ""}…
        </span>
      </div>
    </div>
  );
}

export function MissionLiveFeed({
  missionId,
  items,
  running,
}: {
  missionId: string;
  items: ApiBacklogItem[];
  running: boolean;
}) {
  if (!running) return null;
  const live = items.filter((i) => i.status === "in_progress");

  return (
    <section className="mt-6">
      <h2 className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-[0.28em] text-dim">
        <LuActivity className="h-3.5 w-3.5 text-builder" />
        Live <span className="h-1.5 w-1.5 rounded-full bg-builder pulse-dot" />
      </h2>
      <div className="space-y-2">
        {live.map((it) => (
          <ItemFeed key={it.id} missionId={missionId} item={it} />
        ))}
        {live.length === 0 && (
          // Between batches: decompose/replan/verify/merge — the coordinator has the floor.
          <div className="rise rounded-box border border-line bg-panel px-4 py-3">
            <div className="flex items-center gap-2 text-xs">
              <span className="h-1.5 w-1.5 rounded-full bg-warning pulse-dot" />
              <span className="skeleton skeleton-text">
                Koordinatoren planlægger næste skridt…
              </span>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
