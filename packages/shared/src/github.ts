/**
 * GitHub repo discovery (the "super nemt" half of the GitHub-linked repo model).
 * Lists the repos a fine-grained PAT can WRITE to, so the web UI can show "which
 * repos can I run a mission against" as a dropdown instead of a disk path. Reuses
 * the same `GITHUB_TOKEN` the Publisher pushes with — one credential, whole loop.
 *
 * Pure transport: the GitHub REST API over `fetch`, no octokit. `fetch` is
 * injectable for hermetic tests. The token is never logged here (this module only
 * reads), but callers should still treat results as user data.
 */

export interface GitHubRepo {
  /** Repo owner login (user or org). */
  owner: string;
  /** Repo name. */
  repo: string;
  /** `owner/repo`. */
  fullName: string;
  /** The repo's default branch — the base a mission's PR targets. */
  defaultBranch: string;
  /** Whether the repo is private (for a UI badge). */
  private: boolean;
}

export interface ListGitHubReposOptions {
  /** Fine-grained PAT (repo read at minimum; the same token used to publish). */
  token: string;
  /** GitHub REST base URL, for GitHub Enterprise. Default "https://api.github.com". */
  apiBaseUrl?: string;
  /** Max repos to return (newest-pushed first). Default 200. */
  limit?: number;
  /** Injectable fetch, for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** One repo row as returned by `GET /user/repos`, narrowed to what we use. */
interface RawRepo {
  name: string;
  full_name: string;
  default_branch: string;
  private: boolean;
  owner: { login: string };
  permissions?: { push?: boolean };
}

/**
 * List the repos the token can push to, newest-pushed first. Only push-able repos
 * are returned — running a mission needs write access to open a PR, so a repo you
 * can only read would be a dead end in the picker. Paginates `GET /user/repos`
 * until `limit` is reached or GitHub runs out.
 */
export async function listGitHubRepos(
  options: ListGitHubReposOptions,
): Promise<GitHubRepo[]> {
  const { token } = options;
  const apiBaseUrl = (options.apiBaseUrl ?? "https://api.github.com").replace(/\/$/, "");
  const limit = options.limit ?? 200;
  const doFetch = options.fetchImpl ?? fetch;

  const out: GitHubRepo[] = [];
  const perPage = 100;
  // Cap pages defensively so a huge account can't loop forever (limit also bounds it).
  const maxPages = Math.max(1, Math.ceil(limit / perPage)) + 1;

  for (let page = 1; page <= maxPages && out.length < limit; page++) {
    const res = await doFetch(
      `${apiBaseUrl}/user/repos?per_page=${perPage}&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "agent-engine-mission-worker",
        },
      },
    );
    if (!res.ok) {
      throw new Error(`listing GitHub repos failed (HTTP ${res.status})`);
    }
    const rows = (await res.json()) as RawRepo[];
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows) {
      if (r.permissions?.push !== true) continue; // only repos we can actually open a PR against
      out.push({
        owner: r.owner.login,
        repo: r.name,
        fullName: r.full_name,
        defaultBranch: r.default_branch,
        private: r.private,
      });
      if (out.length >= limit) break;
    }
    if (rows.length < perPage) break; // last page
  }

  return out;
}
