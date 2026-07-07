import { runGit } from "./git.js";

/** Cap the diff fed to the assessor — it also caps again, but keep git output bounded. */
const MAX_PATCH_BYTES = 24_000;

/**
 * Grounded evidence for the project-level rubric assessor: the mission's ACCUMULATED
 * changes on its integration branch — commits + changed-file stat + a capped unified
 * diff — computed against the base branch the mission forked from. This is the real,
 * merged, re-verified state of the work (not per-item claims), so the assessor scores
 * the Definition of Done against shipped code and catches cross-item interactions a
 * per-item view would miss.
 *
 * The base branch is discovered (origin/HEAD → main → master) with fallbacks, since
 * missions fork from the repo's default branch without recording its name. If no base
 * can be found the evidence says so rather than throwing — the assessor treats a weak
 * snapshot conservatively (nothing proven met). Pure read-side git plumbing.
 */
export function createMissionEvidence(
  repoPath: string,
  integrationBranch: string,
): () => Promise<string> {
  return async () => {
    const candidates: string[] = [];
    const originHead = (
      await runGit(repoPath, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])
    ).output.trim();
    if (originHead) candidates.push(originHead.replace(/^refs\/remotes\//, ""));
    candidates.push("main", "master");

    let base: string | undefined;
    for (const c of candidates) {
      if (!c || c === integrationBranch) continue;
      const ok = (await runGit(repoPath, ["rev-parse", "--verify", "--quiet", c])).code === 0;
      if (ok) {
        base = c;
        break;
      }
    }
    if (!base) return "(no base branch found to diff the mission branch against)";

    // Three-dot: changes on the integration branch since it diverged from base.
    const range3 = `${base}...${integrationBranch}`;
    const range2 = `${base}..${integrationBranch}`;
    const log = (
      await runGit(repoPath, ["--no-pager", "log", "--oneline", "--no-decorate", range2])
    ).output.trim();
    const stat = (
      await runGit(repoPath, ["--no-pager", "diff", "--stat", range3])
    ).output.trim();
    const rawPatch = (await runGit(repoPath, ["--no-pager", "diff", range3])).output;
    const patch =
      rawPatch.length > MAX_PATCH_BYTES
        ? `${rawPatch.slice(0, MAX_PATCH_BYTES)}\n…(diff truncated)`
        : rawPatch;

    return (
      [
        log ? `## Commits (${range2})\n${log}` : "",
        stat ? `## Files changed\n${stat}` : "",
        patch.trim() ? `## Diff\n${patch}` : "",
      ]
        .filter(Boolean)
        .join("\n\n") || "(no changes on the mission branch yet)"
    );
  };
}
