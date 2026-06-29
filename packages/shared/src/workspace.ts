import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runGit, type GitResult } from "./git.js";

/**
 * Managed workspace clones (the cloud half of the GitHub-linked repo model). A
 * mission targets a GitHub repo, not a disk path; this ensures a working clone
 * exists under a managed root on the VPS — invisible to the user — and returns its
 * path so the rest of the mission machinery (worktrees, integrator, verifier,
 * publisher) works unchanged. Clones are a CACHE: deleting one just means the next
 * mission re-clones.
 *
 * The token is used ONLY for the clone/fetch transport and is NEVER persisted:
 * after cloning, `origin` is rewritten to the clean URL, so the token never lands
 * in `.git/config`, and it is scrubbed from any error string. The Publisher pushes
 * with its own explicit tokenised URL, so a clean `origin` here is fine.
 */

export interface EnsureWorkspaceOptions {
  /** Base dir all clones live under, e.g. `/opt/agent-engine/workspaces`. */
  root: string;
  owner: string;
  repo: string;
  /** Fine-grained PAT, for the authed clone/fetch transport (not stored). */
  token: string;
  /** Git host. Default "github.com". */
  host?: string;
  /** Injectable git runner, for tests. Defaults to the real `runGit`. */
  gitImpl?: (cwd: string, args: string[]) => Promise<GitResult>;
  /** Injectable existence check, for tests. Defaults to fs `existsSync`. */
  existsImpl?: (path: string) => boolean;
}

export interface EnsureWorkspaceResult {
  /** Absolute path to the working clone — assign this to the mission's repoPath. */
  path: string;
  /** Whether this call created the clone (true) or refreshed an existing one (false). */
  cloned: boolean;
  /** The repo's default branch, fast-forwarded to the freshly-fetched upstream. */
  defaultBranch: string;
}

/**
 * Ensure a working clone of `owner/repo` exists under `root` and is up to date with
 * upstream's default branch, then return its path. Clones on first use; on later
 * calls it fetches and fast-forwards the default branch so each mission starts from
 * fresh upstream code. Existing mission branches are left untouched. Best-effort on
 * refresh: a fetch hiccup on an existing clone is non-fatal (the mission runs against
 * the last-known state) — only a failed initial clone throws.
 */
export async function ensureWorkspace(
  options: EnsureWorkspaceOptions,
): Promise<EnsureWorkspaceResult> {
  const { root, owner, repo, token } = options;
  const host = options.host ?? "github.com";
  const doGit = options.gitImpl ?? runGit;
  const exists = options.existsImpl ?? existsSync;
  const scrub = (s: string): string => (token ? s.split(token).join("***") : s);

  const dir = join(root, owner, repo);
  const authUrl = `https://x-access-token:${token}@${host}/${owner}/${repo}.git`;
  const cleanUrl = `https://${host}/${owner}/${repo}.git`;

  if (!exists(join(dir, ".git"))) {
    // Fresh clone. Parent dir first (root/owner may not exist yet).
    await mkdir(dirname(dir), { recursive: true });
    const cloned = await doGit(root, ["clone", authUrl, dir]);
    if (cloned.code !== 0) {
      throw new Error(`cloning ${owner}/${repo} failed: ${scrub(cloned.output.trim()).slice(0, 400)}`);
    }
    // Drop the tokenised origin so the token never persists in .git/config.
    await doGit(dir, ["remote", "set-url", "origin", cleanUrl]);
    const head = await doGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
    return { path: dir, cloned: true, defaultBranch: head.output.trim() || "main" };
  }

  // Existing clone — refresh the default branch from upstream (best-effort).
  const head = await doGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const defaultBranch = head.output.trim() || "main";
  // Fetch with an explicit tokenised URL (not stored) so private repos still update.
  await doGit(dir, ["fetch", authUrl, `+refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`]);
  // Fast-forward only — never clobber local mission work with a merge/reset.
  await doGit(dir, ["checkout", defaultBranch]);
  await doGit(dir, ["merge", "--ff-only", `refs/remotes/origin/${defaultBranch}`]);
  return { path: dir, cloned: false, defaultBranch };
}
