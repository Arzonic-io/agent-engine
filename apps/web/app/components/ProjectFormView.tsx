"use client";

import { useState } from "react";
import { LuFolderGit2, LuHardDrive, LuUsers } from "react-icons/lu";
import type { RepoInfo, RoleModelsConfig } from "@arzonic/agent-client";
import { GitHubRepoPicker, type GitHubRepoRef } from "./GitHubRepoPicker";
import { RepoPicker } from "./RepoPicker";
import {
  TEAM_ROLES,
  TeamModelPicker,
  roleModelsToSelection,
  selectionToRoleModels,
  teamCount,
  type TeamSelection,
} from "./TeamModelPicker";

/**
 * Full-screen project form — used for the first-ever project, the "Nyt projekt"
 * flow, and editing an existing project. Replaces the composer rather than
 * stacking on it. Both create and edit include the repo picker.
 *
 * `onSubmit` reports `repoPath` as a trimmed string ("" = no repo); the caller
 * maps it (create omits an empty repo; edit clears it).
 */
export function ProjectFormView({
  mode,
  firstEver = false,
  repos,
  initialName = "",
  initialBrief = "",
  initialRepo = "",
  initialGithubRepo = null,
  initialTeam,
  error,
  submitting,
  onSubmit,
  onCancel,
}: {
  mode: "create" | "edit";
  firstEver?: boolean;
  repos: RepoInfo[];
  initialName?: string;
  initialBrief?: string;
  initialRepo?: string;
  /** The project's stored GitHub repo binding (edit mode), if it was bound via the picker. */
  initialGithubRepo?: GitHubRepoRef | null;
  /** The project's stored default team config (edit mode); new missions inherit it. */
  initialTeam?: RoleModelsConfig;
  error?: string | null;
  submitting?: boolean;
  onSubmit: (data: {
    name: string;
    brief: string;
    repoPath: string;
    githubRepo: GitHubRepoRef | null;
    roleModels: RoleModelsConfig;
  }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [brief, setBrief] = useState(initialBrief);
  const [repo, setRepo] = useState(initialRepo);
  const [githubRepo, setGithubRepo] = useState<GitHubRepoRef | null>(initialGithubRepo ?? null);
  // Local-path picker is the advanced fallback; default open only if a path is
  // pre-set without a GitHub binding (e.g. an older project bound by path).
  const [showLocal, setShowLocal] = useState(!!initialRepo && !initialGithubRepo);
  const [team, setTeam] = useState<TeamSelection>(() => roleModelsToSelection(initialTeam));
  const [showTeam, setShowTeam] = useState(false);
  const isEdit = mode === "edit";

  const submit = () => {
    if (!name.trim() || submitting) return;
    onSubmit({
      name,
      brief,
      // A GitHub binding wins; otherwise fall back to the local path.
      repoPath: githubRepo ? "" : repo.trim(),
      githubRepo,
      roleModels: selectionToRoleModels(team),
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
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="inline-flex shrink-0 items-center gap-1 text-xs text-dim">
                <LuFolderGit2 className="h-3.5 w-3.5" /> Repo
              </span>
              <GitHubRepoPicker
                value={githubRepo}
                onChange={(v) => {
                  setGithubRepo(v);
                  // Picking a GitHub repo supersedes any typed local path.
                  if (v) setRepo("");
                }}
              />
            </div>
            {/* Advanced fallback: a local/discovered path (dev, or no GITHUB_TOKEN). */}
            <button
              type="button"
              onClick={() => setShowLocal((v) => !v)}
              className="ml-[3.25rem] inline-flex items-center gap-1 text-[11px] text-dim transition hover:text-fg"
            >
              <LuHardDrive className="h-3 w-3" />
              {showLocal ? "Skjul lokal sti" : "…eller en lokal sti"}
            </button>
            {showLocal && (
              <div className="ml-[3.25rem]">
                <RepoPicker
                  repos={repos}
                  value={repo}
                  onChange={(v) => {
                    setRepo(v);
                    // A local path supersedes a GitHub binding.
                    if (v.trim()) setGithubRepo(null);
                  }}
                />
              </div>
            )}
          </div>

          {/* Project default team — new missions inherit it; a mission can still override. */}
          <div className="rounded-field border border-line bg-elev/40">
            <button
              type="button"
              onClick={() => setShowTeam((v) => !v)}
              className="flex w-full items-center justify-between px-2.5 py-2 text-xs text-dim transition hover:text-fg"
            >
              <span className="inline-flex items-center gap-1.5">
                <LuUsers className="h-3.5 w-3.5" /> Team-modeller (projektets standard)
              </span>
              <span className="text-[10px] text-fg/60">
                {teamCount(team) > 0 ? `${teamCount(team)} valgt` : "Standard"}
              </span>
            </button>
            {showTeam && (
              <div className="border-t border-line p-2">
                <p className="mb-2 text-[11px] leading-relaxed text-dim">
                  Nye missioner i projektet arver disse modeller. En enkelt mission kan stadig
                  overstyre dem i sin opsætning.
                </p>
                <TeamModelPicker roles={TEAM_ROLES} value={team} onChange={setTeam} />
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={submit}
              disabled={!name.trim() || submitting}
              className="btn btn-primary btn-sm flex-1 font-bold normal-case"
            >
              {isEdit ? "Gem ændringer" : "Opret projekt"}
            </button>
            {!firstEver && (
              <button onClick={onCancel} className="btn btn-ghost btn-sm text-dim normal-case">
                Annuller
              </button>
            )}
          </div>
        </div>

        {error && <p className="rise mt-4 text-sm text-error">{error}</p>}
      </div>
    </div>
  );
}
