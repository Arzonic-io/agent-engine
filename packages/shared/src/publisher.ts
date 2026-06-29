import type { Mission, MissionDigest, PublishInput, PublishResult, Publisher } from "@arzonic/agent-core";
import { runGit, type GitResult } from "./git.js";

/**
 * GitHub-backed `Publisher` (overnight-trust "del b"). Pushes a mission's
 * integration branch to `origin` and opens (or reuses) a pull request against the
 * repo's default branch, so the night's autonomous work is reviewable in the
 * morning. Uses jenkins-free plumbing: the existing `git` spawner for the push and
 * the GitHub REST API over `fetch` for the PR — no new dependency.
 *
 * Auth is a fine-grained PAT (Contents + Pull-requests: write on the target
 * repos), passed in from env. The token is embedded in the HTTPS push URL and in
 * the REST Authorization header; every string that could carry it is SCRUBBED
 * before it reaches an error message or the journal, so it can never leak into a
 * log line.
 *
 * Idempotent: a branch that already has an open PR returns that PR rather than
 * failing, so a resumed/re-published mission doesn't open duplicates.
 */

export interface GitHubPublisherOptions {
  /** Fine-grained PAT with Contents + Pull-requests (write) on the target repos. */
  token: string;
  /** Open the PR as a draft (default true) — CI runs, a human marks it ready. */
  draft?: boolean;
  /** GitHub REST base URL, for GitHub Enterprise. Default "https://api.github.com". */
  apiBaseUrl?: string;
  /** Injectable fetch, for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable git runner, for tests. Defaults to the real `runGit` spawner. */
  gitImpl?: (cwd: string, args: string[]) => Promise<GitResult>;
}

interface ParsedRemote {
  host: string;
  owner: string;
  repo: string;
}

/**
 * Parse an `origin` URL into host/owner/repo. Handles the SSH form
 * (`git@github.com:owner/repo.git`), the HTTPS form
 * (`https://github.com/owner/repo(.git)`), and an HTTPS URL that already carries
 * credentials (`https://user:tok@github.com/owner/repo.git`). Returns null for
 * anything we can't recognise.
 */
export function parseGitHubRemote(url: string): ParsedRemote | null {
  const trimmed = url.trim().replace(/\.git$/, "");
  // SSH: git@host:owner/repo
  const ssh = /^(?:ssh:\/\/)?[^@]+@([^:/]+)[:/](.+?)\/([^/]+)$/.exec(trimmed);
  if (ssh) return { host: ssh[1]!, owner: ssh[2]!.split("/").pop()!, repo: ssh[3]! };
  // HTTPS (optionally with embedded credentials): https://[user[:pass]@]host/owner/repo
  const https = /^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)\/([^/]+)$/.exec(trimmed);
  if (https) return { host: https[1]!, owner: https[2]!.split("/").pop()!, repo: https[3]! };
  return null;
}

const truncate = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s;

/** Compose the PR body from the mission goal + the terminal digest rollup. */
function buildPrBody(mission: Mission, digest: MissionDigest): string {
  const lines: string[] = [];
  lines.push("> 🤖 Opened autonomously by the agent-engine mission worker — review before merging.", "");
  lines.push(`**Goal:** ${mission.goal}`, "");
  if (mission.acceptanceCriteria.length > 0) {
    lines.push("**Acceptance criteria:**");
    for (const c of mission.acceptanceCriteria) lines.push(`- ${c}`);
    lines.push("");
  }
  lines.push(
    `**Outcome:** ${digest.done.length} done · ${digest.parked.length} parked · ` +
      `${digest.failed.length} failed · ${digest.pending} pending · ${digest.spentTokens} tokens`,
    "",
  );
  if (digest.done.length > 0) {
    lines.push("**Completed:**");
    for (const t of digest.done) lines.push(`- ${t}`);
    lines.push("");
  }
  if (digest.blocked.length > 0) {
    lines.push("**Needs a human (parked):**");
    for (const b of digest.blocked) lines.push(`- ${b.title} — _${b.reason}_`);
    lines.push("");
  }
  lines.push(`<sub>mission \`${mission.id}\` · status \`${digest.status}\`</sub>`);
  return lines.join("\n");
}

export function createGitHubPublisher(options: GitHubPublisherOptions): Publisher {
  const { token } = options;
  const draft = options.draft ?? true;
  const apiBaseUrl = (options.apiBaseUrl ?? "https://api.github.com").replace(/\/$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  const doGit = options.gitImpl ?? runGit;
  /** Strip the token from any string before it can reach a log/journal line. */
  const scrub = (s: string): string => (token ? s.split(token).join("***") : s);

  const ghFetch = (path: string, init?: RequestInit): Promise<Response> =>
    doFetch(`${apiBaseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "agent-engine-mission-worker",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });

  return {
    async publish({ mission, branch, digest }: PublishInput): Promise<PublishResult> {
      const repoPath = mission.repoPath;

      // 1) Resolve the GitHub remote.
      const remote = await doGit(repoPath, ["remote", "get-url", "origin"]);
      if (remote.code !== 0) {
        return { url: null, note: "no 'origin' remote — nothing published" };
      }
      const parsed = parseGitHubRemote(remote.output);
      if (!parsed) {
        return { url: null, note: "origin is not a recognised GitHub remote — nothing published" };
      }
      const { host, owner, repo } = parsed;

      // 2) Find the default branch (the PR base) — also proves the token can read the repo.
      const repoRes = await ghFetch(`/repos/${owner}/${repo}`);
      if (!repoRes.ok) {
        return {
          url: null,
          note: `could not read ${owner}/${repo} (HTTP ${repoRes.status}) — check the token's scope/access`,
        };
      }
      const base = ((await repoRes.json()) as { default_branch?: string }).default_branch ?? "main";

      // 3) Is the branch actually ahead of base? Best-effort: a git hiccup here just
      //    lets us proceed to push rather than silently skipping real work.
      const ahead = await doGit(repoPath, ["rev-list", "--count", `${base}..${branch}`]);
      if (ahead.code === 0 && ahead.output.trim() === "0") {
        return { url: null, note: `nothing to publish — ${branch} has no commits beyond ${base}` };
      }

      // 4) Push the branch with a tokenised URL (never logged: errors are scrubbed).
      const pushUrl = `https://x-access-token:${token}@${host}/${owner}/${repo}.git`;
      const push = await doGit(repoPath, ["push", pushUrl, `${branch}:refs/heads/${branch}`]);
      if (push.code !== 0) {
        throw new Error(`git push of ${branch} failed: ${truncate(scrub(push.output.trim()), 400)}`);
      }

      // 5) Reuse an open PR for this head if one exists (idempotent on resume).
      const existing = await ghFetch(
        `/repos/${owner}/${repo}/pulls?head=${owner}:${branch}&state=open`,
      );
      if (existing.ok) {
        const open = (await existing.json()) as Array<{ html_url: string; number: number }>;
        if (open.length > 0) {
          return { url: open[0]!.html_url, note: `reused open PR #${open[0]!.number}` };
        }
      }

      // 6) Open a new PR against the default branch.
      const createRes = await ghFetch(`/repos/${owner}/${repo}/pulls`, {
        method: "POST",
        body: JSON.stringify({
          title: `Mission: ${truncate(mission.goal, 70)}`,
          head: branch,
          base,
          body: buildPrBody(mission, digest),
          draft,
        }),
      });
      if (!createRes.ok) {
        const detail = scrub((await createRes.text()).slice(0, 300));
        throw new Error(`opening PR failed (HTTP ${createRes.status}): ${detail}`);
      }
      const pr = (await createRes.json()) as { html_url: string; number: number };
      return { url: pr.html_url, note: `opened ${draft ? "draft " : ""}PR #${pr.number}` };
    },
  };
}
