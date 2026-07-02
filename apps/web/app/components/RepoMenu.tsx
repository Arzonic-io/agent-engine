"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LuCheck, LuChevronDown, LuFolderGit2, LuFolderPlus, LuX } from "react-icons/lu";
import type { RepoInfo } from "@arzonic/agent-client";
import { repoLabel } from "../lib/format";

/**
 * The project's repo, as a VS-Code-style dropdown button. The menu is portaled
 * to `document.body` (fixed) so it floats above every card instead of getting
 * trapped under a sibling's stacking context. The parent owns persistence —
 * this just reports the chosen path (or null to clear).
 */
export function RepoMenu({
  repos,
  localRepos = true,
  value,
  onChange,
  saving,
}: {
  repos: RepoInfo[];
  /**
   * Whether local-path binding is offered (off on the cloud deploy —
   * WEB_LOCAL_REPOS=off): the menu then only explains where to bind a repo
   * (the GitHub picker in "Rediger") and still allows clearing the current one.
   */
  localRepos?: boolean;
  value: string;
  onChange: (path: string | null) => void;
  saving?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = () => {
      setOpen(false);
      setCustomOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  const pick = (path: string | null) => {
    setOpen(false);
    onChange(path);
  };

  return (
    <div className="text-xs">
      <button
        ref={btnRef}
        onClick={(e) => {
          e.stopPropagation();
          if (open) {
            setOpen(false);
            return;
          }
          const r = btnRef.current?.getBoundingClientRect();
          if (r) setPos({ top: r.bottom + 4, left: Math.min(r.left, window.innerWidth - 264) });
          setCustomOpen(false);
          setOpen(true);
        }}
        className={`inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 transition hover:bg-elev ${
          open ? "bg-elev" : "bg-elev/60"
        }`}
      >
        <LuFolderGit2 className={`h-3.5 w-3.5 ${value ? "text-builder" : "text-dim"}`} />
        <span className={value ? "text-fg/90" : "text-dim"}>
          {value ? repoLabel(value, repos) : "Tilknyt repo"}
        </span>
        <LuChevronDown
          className={`h-3.5 w-3.5 text-dim transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open &&
        pos &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="fixed z-[100] w-64 overflow-hidden rounded-box border border-line bg-elev py-1 text-xs shadow-xl shadow-black/40"
            style={{ top: pos.top, left: pos.left }}
            onClick={(e) => e.stopPropagation()}
          >
            {localRepos ? (
              <>
                <p className="px-3 py-1 text-[10px] uppercase tracking-[0.2em] text-dim">Repos</p>
                <div className="max-h-56 overflow-y-auto">
                  {repos.length === 0 ? (
                    <p className="px-3 py-2 text-xs text-dim">Ingen repos fundet.</p>
                  ) : (
                    repos.map((r) => (
                      <button
                        key={r.path}
                        onClick={() => pick(r.path)}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition hover:bg-panel"
                      >
                        <LuCheck
                          className={`h-3.5 w-3.5 shrink-0 text-builder ${
                            r.path === value ? "opacity-100" : "opacity-0"
                          }`}
                        />
                        <span className="truncate text-fg/90">{r.name}</span>
                      </button>
                    ))
                  )}
                </div>

                <div className="my-1 border-t border-line" />

                {customOpen ? (
                  <div className="flex items-center gap-1 px-2 py-1">
                    <input
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") pick(draft.trim() || null);
                      }}
                      placeholder="repo-sti…"
                      className="input input-xs flex-1 border-line bg-panel"
                    />
                    <button
                      onClick={() => pick(draft.trim() || null)}
                      disabled={saving}
                      className="btn btn-primary btn-xs normal-case"
                    >
                      Gem
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => {
                      setDraft(value);
                      setCustomOpen(true);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-dim transition hover:bg-panel"
                  >
                    <LuFolderPlus className="h-3.5 w-3.5" /> Custom sti…
                  </button>
                )}
              </>
            ) : (
              // Cloud deploy: no local paths — the GitHub picker (in "Rediger") is
              // the only way to bind a repo; here you can only see/clear it.
              <p className="px-3 py-2 text-xs leading-relaxed text-dim">
                Repoet vælges via GitHub — brug <span className="text-fg/80">Rediger</span> på
                projektet. Lokale stier er slået fra på cloud-udgaven.
              </p>
            )}

            {value && (
              <button
                onClick={() => pick(null)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-error transition hover:bg-error/10"
              >
                <LuX className="h-3.5 w-3.5" /> Fjern repo
              </button>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
