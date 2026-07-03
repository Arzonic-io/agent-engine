"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { LuTrash2 } from "react-icons/lu";
import { type GitHubRepoRef } from "./GitHubRepoPicker";
import { RepoField } from "./RepoField";

/**
 * Full-screen project form — used for the first-ever project, the "Nyt projekt"
 * flow, and editing an existing project. Replaces the composer rather than
 * stacking on it. Both create and edit include the repo picker.
 *
 * No team/model picking here by design: every project runs on the global default
 * team from Settings — models are only chosen per MISSION (in its composer or on
 * the running mission's dashboard).
 *
 * `onSubmit` reports `repoPath` as a trimmed string ("" = no repo); the caller
 * maps it (create omits an empty repo; edit clears it).
 */
export function ProjectFormView({
  mode,
  firstEver = false,
  initialName = "",
  initialBrief = "",
  initialRepo = "",
  initialGithubRepo = null,
  error,
  submitting,
  onSubmit,
  onCancel,
  onDelete,
}: {
  mode: "create" | "edit";
  firstEver?: boolean;
  initialName?: string;
  initialBrief?: string;
  initialRepo?: string;
  /** The project's stored GitHub repo binding (edit mode), if it was bound via the picker. */
  initialGithubRepo?: GitHubRepoRef | null;
  error?: string | null;
  submitting?: boolean;
  onSubmit: (data: {
    name: string;
    brief: string;
    repoPath: string;
    githubRepo: GitHubRepoRef | null;
  }) => void;
  onCancel: () => void;
  /** Delete this project (edit mode only). Confirmed here before it fires. */
  onDelete?: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [brief, setBrief] = useState(initialBrief);
  const [repo, setRepo] = useState(initialRepo);
  const [githubRepo, setGithubRepo] = useState<GitHubRepoRef | null>(initialGithubRepo ?? null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isEdit = mode === "edit";

  const submit = () => {
    if (!name.trim() || submitting) return;
    onSubmit({
      name,
      brief,
      // A GitHub binding wins; otherwise fall back to the local path.
      repoPath: githubRepo ? "" : repo.trim(),
      githubRepo,
    });
  };

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto px-6 sm:px-8">
      <div className="w-full max-w-lg py-10">
        <div className="rise mb-6">
          <p className="mb-3 text-xs uppercase tracking-[0.35em] text-dim">
            {isEdit ? "Rediger projekt" : firstEver ? "Kom i gang" : "Nyt projekt"}
          </p>
          <h1 className="display text-4xl font-extrabold leading-[1.08] tracking-tight">
            {isEdit ? (
              <>
                Rediger <span className="text-builder">projekt</span>
              </>
            ) : firstEver ? (
              <>
                Opret dit <span className="text-builder">første projekt</span>
              </>
            ) : (
              <>
                Opret et <span className="text-builder">nyt projekt</span>
              </>
            )}
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-dim">
            {isEdit
              ? "Justér navn, brief og repo. Teamet bruger brief'en som projektets stående kontekst."
              : "Opgaver hører til et projekt. Teamet husker projektets mål, beslutninger og tidligere arbejde - så hver opgave bygger videre i stedet for at starte fra nul."}
          </p>
        </div>

        <div
          className="rise space-y-2 rounded-box border border-line bg-panel p-3 shadow-2xl shadow-black/30"
          style={{ animationDelay: "60ms" }}
        >
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            placeholder="Projektnavn (fx Ranky forside)"
            className="input input-sm w-full border-line bg-elev"
          />
          <textarea
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            rows={3}
            placeholder="Brief - projektets stående mål og kontekst (teamet husker dette)"
            className="textarea textarea-sm w-full resize-none border-line bg-elev"
          />
          <RepoField
            githubRepo={githubRepo}
            onGithub={(v) => {
              setGithubRepo(v);
              // Picking a GitHub repo clears any legacy local path.
              setRepo(v ? "" : repo);
            }}
          />

          <div className="flex items-center gap-2 pt-1">
            <div className={!name.trim() || submitting ? "flex-1" : "aura aura-dual flex-1 text-primary"}>
              <button
                onClick={submit}
                disabled={!name.trim() || submitting}
                className="btn btn-soft btn-sm w-full"
              >
                {submitting ? (
                  <span className="skeleton skeleton-text">
                    {isEdit ? "Gemmer ændringer…" : "Opretter projekt…"}
                  </span>
                ) : isEdit ? (
                  "Gem ændringer"
                ) : (
                  "Opret projekt"
                )}
              </button>
            </div>
            {!firstEver && (
              <button onClick={onCancel} className="btn btn-ghost btn-sm text-dim normal-case">
                Annuller
              </button>
            )}
          </div>

          {/* Delete lives in the edit form so it's discoverable — not only via a
              right-click in the rail. Confirmed before it fires. */}
          {isEdit && onDelete && (
            <div className="border-t border-line pt-2">
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                disabled={submitting}
                className="btn btn-ghost btn-sm gap-1.5 text-error normal-case hover:bg-error/10"
              >
                <LuTrash2 className="h-4 w-4" /> Slet projekt
              </button>
            </div>
          )}
        </div>

        {error && <p className="rise mt-4 text-sm text-error">{error}</p>}
      </div>

      {/* Delete confirmation — PORTALED to <body>: an ancestor's retained
          transform (the `rise` entrance) would otherwise trap this fixed modal
          so the overlay only covered part of the window. */}
      {confirmDelete &&
        onDelete &&
        typeof document !== "undefined" &&
        createPortal(
          <div className="modal modal-open z-[110]">
            <div className="modal-box border border-line bg-panel">
              <h3 className="text-base font-bold">Slet projekt?</h3>
              <p className="py-3 text-sm leading-relaxed text-dim">
                <span className="text-fg">{name || "Projektet"}</span> slettes permanent — sammen med
                alle dets opgaver, missioner og hukommelse. Dette kan ikke fortrydes.
              </p>
              <div className="modal-action">
                <button
                  onClick={() => setConfirmDelete(false)}
                  className="btn btn-ghost btn-sm normal-case"
                >
                  Annuller
                </button>
                <button
                  onClick={() => {
                    setConfirmDelete(false);
                    onDelete();
                  }}
                  className="btn btn-error btn-sm gap-1.5 normal-case"
                >
                  <LuTrash2 className="h-4 w-4" /> Slet projekt
                </button>
              </div>
            </div>
            <div className="modal-backdrop bg-black/60" onClick={() => setConfirmDelete(false)} />
          </div>,
          document.body,
        )}
    </div>
  );
}
