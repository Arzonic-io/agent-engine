"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  LuCheck,
  LuChevronsUpDown,
  LuGitBranch,
  LuGithub,
  LuLock,
  LuSearch,
  LuX,
} from "react-icons/lu";
import type { GitHubRepo } from "@arzonic/agent-client";

export type GitHubRepoRef = { owner: string; repo: string };

/**
 * Slick GitHub repo picker — search + select from the repos the configured token
 * can push to, instead of typing a path. Fetches `/api/repos/github` once; a 503
 * (no GITHUB_TOKEN) surfaces a hint and the caller's local-path fallback. Selecting
 * a repo emits `{ owner, repo }`; the backend clones it to a workspace on save.
 */
export function GitHubRepoPicker({
  value,
  onChange,
}: {
  value: GitHubRepoRef | null;
  onChange: (v: GitHubRepoRef | null) => void;
}) {
  const [repos, setRepos] = useState<GitHubRepo[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [tokenMissing, setTokenMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/repos/github");
        if (res.status === 503) {
          if (alive) setTokenMissing(true);
          return;
        }
        if (!res.ok) throw new Error(await res.text());
        const data = (await res.json()) as GitHubRepo[];
        if (alive) setRepos(data);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "Kunne ikke hente repos");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

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
    const list = repos ?? [];
    const q = query.trim().toLowerCase();
    return q ? list.filter((r) => r.fullName.toLowerCase().includes(q)) : list;
  }, [repos, query]);

  if (tokenMissing) {
    return (
      <p className="flex flex-1 items-center gap-1.5 text-[11px] leading-relaxed text-dim">
        <LuGithub className="h-3.5 w-3.5 shrink-0" />
        Sæt <code className="rounded bg-elev px-1">GITHUB_TOKEN</code> for at vælge GitHub-repos.
      </p>
    );
  }

  const label = value ? `${value.owner}/${value.repo}` : null;

  return (
    <div ref={boxRef} className="relative flex-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-field border border-line bg-elev px-2.5 py-1.5 text-left text-sm transition hover:border-builder/50"
      >
        <LuGithub className="h-3.5 w-3.5 shrink-0 text-dim" />
        <span className={`flex-1 truncate ${label ? "text-fg" : "text-dim"}`}>
          {loading ? "Henter dine repos…" : label ?? "Vælg et GitHub-repo"}
        </span>
        {value && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onChange(null);
            }}
            className="rounded p-0.5 text-dim hover:bg-line hover:text-fg"
            aria-label="Ryd valg"
          >
            <LuX className="h-3.5 w-3.5" />
          </span>
        )}
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
              placeholder="Søg repo…"
              className="w-full bg-transparent text-sm outline-none placeholder:text-dim"
            />
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            {error && <p className="px-3 py-2 text-xs text-error">{error}</p>}
            {!error && filtered.length === 0 && (
              <p className="px-3 py-2 text-xs text-dim">
                {loading ? "Henter…" : query ? "Ingen match." : "Ingen repos med skriveadgang."}
              </p>
            )}
            {filtered.map((r) => {
              const active = value?.owner === r.owner && value?.repo === r.repo;
              return (
                <button
                  key={r.fullName}
                  type="button"
                  onClick={() => {
                    onChange({ owner: r.owner, repo: r.repo });
                    setOpen(false);
                    setQuery("");
                  }}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition hover:bg-elev ${
                    active ? "bg-elev" : ""
                  }`}
                >
                  <LuCheck
                    className={`h-3.5 w-3.5 shrink-0 ${active ? "text-builder" : "text-transparent"}`}
                  />
                  <span className="flex-1 truncate">
                    <span className="text-dim">{r.owner}/</span>
                    <span className="font-medium text-fg">{r.repo}</span>
                  </span>
                  {r.private && <LuLock className="h-3 w-3 shrink-0 text-dim" title="Privat" />}
                  <span className="inline-flex shrink-0 items-center gap-1 rounded bg-elev px-1.5 py-0.5 text-[10px] text-dim">
                    <LuGitBranch className="h-2.5 w-2.5" />
                    {r.defaultBranch}
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
