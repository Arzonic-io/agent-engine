"use client";

import { LuFolderGit2 } from "react-icons/lu";
import { GitHubRepoPicker, type GitHubRepoRef } from "./GitHubRepoPicker";

/**
 * The one repo picker, shared by the new/edit-project form and the project-view
 * composer header so both are identical: pick a GitHub repo (the binding that
 * enables draft PRs). The old local-path fallback is gone — repos are bound via
 * GitHub, the same locally and online. Fully controlled: the parent owns the value
 * and decides what a change means (the form batches into state; the header saves live).
 */
export function RepoField({
  githubRepo,
  onGithub,
  saving = false,
}: {
  githubRepo: GitHubRepoRef | null;
  onGithub: (v: GitHubRepoRef | null) => void;
  /** Show a spinner next to the picker while a live save is in flight (header use). */
  saving?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="inline-flex shrink-0 items-center gap-1 text-xs text-dim">
        <LuFolderGit2 className="h-3.5 w-3.5" /> Repo
      </span>
      <GitHubRepoPicker value={githubRepo} onChange={onGithub} />
      {saving && <span className="loading loading-spinner loading-xs shrink-0 text-dim" />}
    </div>
  );
}
