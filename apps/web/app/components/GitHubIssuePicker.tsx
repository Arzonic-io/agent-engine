"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  LuChevronsUpDown,
  LuCircleDot,
  LuGithub,
  LuSearch,
  LuTag,
} from "react-icons/lu";
import type { GitHubIssue } from "@arzonic/agent-client";

/**
 * Picker for a repo's open GitHub issues — the "start a mission from an issue"
 * flow (mirrors GitHubRepoPicker). Fetches `/api/repos/github/issues` for the
 * project's bound repo; a 503 (no GITHUB_TOKEN) hides itself. Selecting an issue
 * emits it so the composer can prefill the goal/criteria and remember its number
 * (the mission's PR later `Closes #n`).
 */
export function GitHubIssuePicker({
  owner,
  repo,
  selectedNumber,
  onSelect,
}: {
  owner: string;
  repo: string;
  selectedNumber?: number | null;
  onSelect: (issue: GitHubIssue) => void;
}) {
  const [issues, setIssues] = useState<GitHubIssue[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [tokenMissing, setTokenMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!owner || !repo) return;
    let alive = true;
    setLoading(true);
    void (async () => {
      try {
        const res = await fetch(
          `/api/repos/github/issues?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`,
        );
        if (res.status === 503) {
          if (alive) setTokenMissing(true);
          return;
        }
        if (!res.ok) {
          // The API returns { message } (NestJS shape) — show that, not raw JSON.
          const body = await res.text();
          let msg = body;
          try {
            const j = JSON.parse(body) as { message?: string };
            if (j?.message) msg = j.message;
          } catch {
            /* non-JSON — show the body as-is */
          }
          throw new Error(msg);
        }
        const data = (await res.json()) as GitHubIssue[];
        if (alive) setIssues(data);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "Kunne ikke hente issues");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [owner, repo]);

  // Close the dropdown on an outside click.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const filtered = useMemo(() => {
    const list = issues ?? [];
    const q = query.trim().toLowerCase();
    return q
      ? list.filter(
          (i) => i.title.toLowerCase().includes(q) || String(i.number).includes(q),
        )
      : list;
  }, [issues, query]);

  // No token, or the repo simply has no picker → render nothing (feature hidden).
  if (tokenMissing) return null;

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-field border border-line bg-elev px-2.5 py-1.5 text-left text-sm transition hover:border-builder/50"
      >
        <LuGithub className="h-3.5 w-3.5 shrink-0 text-dim" />
        <span className={`flex-1 truncate ${selectedNumber ? "text-fg" : "text-dim"}`}>
          {loading
            ? "Henter issues…"
            : selectedNumber
              ? `Startet fra issue #${selectedNumber}`
              : "Start fra et GitHub issue (valgfrit)"}
        </span>
        <LuChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-dim" />
      </button>

      {open && (
        <div className="absolute z-30 mt-1 w-full overflow-hidden rounded-box border border-line bg-panel shadow-2xl shadow-black/40">
          <div className="flex items-center gap-2 border-b border-line px-2.5 py-2">
            <LuSearch className="h-3.5 w-3.5 shrink-0 text-dim" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Søg issue… (titel eller #nummer)"
              className="w-full bg-transparent text-sm outline-none placeholder:text-dim"
            />
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            {error && <p className="px-3 py-2 text-xs text-error">{error}</p>}
            {!error && filtered.length === 0 && (
              <p className="px-3 py-2 text-xs text-dim">
                {loading ? "Henter…" : query ? "Ingen match." : "Ingen åbne issues."}
              </p>
            )}
            {filtered.map((i) => {
              const active = selectedNumber === i.number;
              return (
                <button
                  key={i.number}
                  type="button"
                  onClick={() => {
                    onSelect(i);
                    setOpen(false);
                    setQuery("");
                  }}
                  className={`flex w-full items-start gap-2 px-3 py-1.5 text-left text-sm transition hover:bg-elev ${
                    active ? "bg-elev" : ""
                  }`}
                >
                  <LuCircleDot className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate font-medium text-fg">{i.title}</span>
                      <span className="shrink-0 font-mono text-xs text-dim">#{i.number}</span>
                    </span>
                    {i.labels.length > 0 && (
                      <span className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-dim">
                        <LuTag className="h-2.5 w-2.5" />
                        {i.labels.slice(0, 4).join(" · ")}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
