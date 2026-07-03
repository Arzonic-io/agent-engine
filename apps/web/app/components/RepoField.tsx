"use client";

import { useState } from "react";
import { LuFolderGit2, LuHardDrive } from "react-icons/lu";
import type { RepoInfo } from "@arzonic/agent-client";
import { GitHubRepoPicker, type GitHubRepoRef } from "./GitHubRepoPicker";
import { RepoPicker } from "./RepoPicker";

/**
 * The one repo picker, shared by the new/edit-project form and the project-view
 * composer header so both are identical: pick a GitHub repo, with a local path as
 * an advanced fold-out fallback. Fully controlled — the parent owns the values and
 * decides what a change means (the form batches into state; the header saves live).
 */
export function RepoField({
  repos,
  localRepos = true,
  githubRepo,
  localPath,
  onGithub,
  onLocal,
  saving = false,
}: {
  repos: RepoInfo[];
  /** Whether the local-path fallback is offered at all (off on the cloud deploy). */
  localRepos?: boolean;
  githubRepo: GitHubRepoRef | null;
  localPath: string;
  onGithub: (v: GitHubRepoRef | null) => void;
  onLocal: (v: string) => void;
  /** Show a spinner next to the picker while a live save is in flight (header use). */
  saving?: boolean;
}) {
  // A legacy path-bound project still gets the fold-out even on cloud, so its path
  // can be inspected/cleared. Default open only when a path is set without a GitHub bind.
  const allowLocal = localRepos || !!localPath;
  const [showLocal, setShowLocal] = useState(!!localPath && !githubRepo);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="inline-flex shrink-0 items-center gap-1 text-xs text-dim">
          <LuFolderGit2 className="h-3.5 w-3.5" /> Repo
        </span>
        <GitHubRepoPicker
          value={githubRepo}
          onChange={(v) => {
            onGithub(v);
            if (v) setShowLocal(false);
          }}
        />
        {saving && <span className="loading loading-spinner loading-xs shrink-0 text-dim" />}
      </div>
      {allowLocal && (
        <button
          type="button"
          onClick={() => setShowLocal((v) => !v)}
          className="ml-[3.25rem] inline-flex items-center gap-1 text-[11px] text-dim transition hover:text-fg"
        >
          <LuHardDrive className="h-3 w-3" />
          {showLocal ? "Skjul lokal sti" : "…eller en lokal sti"}
        </button>
      )}
      {allowLocal && showLocal && (
        <div className="ml-[3.25rem]">
          <RepoPicker repos={repos} value={localPath} onChange={onLocal} />
        </div>
      )}
    </div>
  );
}
