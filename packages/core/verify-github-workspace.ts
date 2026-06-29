/**
 * HERMETIC verify for the GitHub-linked repo model — repo listing + workspace
 * clone. No network, no real git: `fetch` and `git` are injected. Proves:
 *   • listGitHubRepos returns only push-able repos, mapped + newest-first, paginated
 *   • ensureWorkspace clones a fresh repo with a tokenised URL, then SCRUBS the
 *     token from origin (never persisted in .git/config)
 *   • ensureWorkspace refreshes an existing clone with ff-only (no clobber)
 *   • a failed initial clone throws WITHOUT leaking the token
 *
 * Run: pnpm --filter @arzonic/agent-core exec tsx verify-github-workspace.ts
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitResult } from "../shared/src/git.js";
import { listGitHubRepos } from "../shared/src/github.js";
import { ensureWorkspace } from "../shared/src/workspace.js";

const ok = (c: boolean, m: string) => {
  if (!c) throw new Error(`FAIL: ${m}`);
  console.log(`  ✓ ${m}`);
};

const TOKEN = "ghp_SUPERSECRETTOKEN1234567890";

function fakeFetch(pages: unknown[][]) {
  const reqs: string[] = [];
  let i = 0;
  const impl = (async (url: string | URL | Request) => {
    reqs.push(String(url));
    const body = pages[i] ?? [];
    i++;
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as unknown as typeof fetch;
  return { impl, reqs };
}

function fakeGit(answers: (args: string[]) => GitResult) {
  const calls: string[][] = [];
  const run = async (_cwd: string, args: string[]): Promise<GitResult> => {
    calls.push(args);
    return answers(args);
  };
  return { run, calls };
}

async function main(): Promise<void> {
  console.log("listGitHubRepos:");
  {
    const page1 = Array.from({ length: 100 }, (_, n) => ({
      name: `repo${n}`,
      full_name: `arzonic/repo${n}`,
      default_branch: "main",
      private: n % 2 === 0,
      owner: { login: "arzonic" },
      permissions: { push: true },
    }));
    const page2 = [
      { name: "writable", full_name: "arzonic/writable", default_branch: "dev", private: false, owner: { login: "arzonic" }, permissions: { push: true } },
      { name: "readonly", full_name: "other/readonly", default_branch: "main", private: false, owner: { login: "other" }, permissions: { push: false } },
    ];
    const fetcher = fakeFetch([page1, page2]);
    const repos = await listGitHubRepos({ token: TOKEN, fetchImpl: fetcher.impl, limit: 200 });
    ok(repos.length === 101, "returns all push-able repos across pages (100 + 1)");
    ok(!repos.some((r) => r.repo === "readonly"), "drops repos without push permission");
    ok(repos[0]!.fullName === "arzonic/repo0" && repos[0]!.defaultBranch === "main", "maps fields correctly");
    ok(fetcher.reqs[0]!.includes("sort=pushed"), "requests newest-pushed first");
    ok(fetcher.reqs.length === 2, "stops paginating on a short page");
  }

  // A real temp dir for the clone path's mkdir (git itself is still faked, so no
  // real clone runs — this just gives `mkdir -p` somewhere harmless to create).
  const wsRoot = await mkdtemp(join(tmpdir(), "ws-verify-"));

  console.log("\nensureWorkspace — fresh clone:");
  {
    const git = fakeGit((args) => {
      if (args[0] === "rev-parse") return { code: 0, output: "main\n" };
      return { code: 0, output: "" };
    });
    const res = await ensureWorkspace({
      root: wsRoot,
      owner: "arzonic",
      repo: "agent-engine",
      token: TOKEN,
      gitImpl: git.run,
      existsImpl: () => false,
    });
    ok(res.cloned === true, "reports a fresh clone");
    ok(res.path === join(wsRoot, "arzonic", "agent-engine"), "returns the workspace path");
    const clone = git.calls.find((c) => c[0] === "clone")!;
    ok(clone[1]!.includes(`x-access-token:${TOKEN}@github.com`), "clones with the tokenised URL");
    const setUrl = git.calls.find((c) => c[0] === "remote" && c[1] === "set-url")!;
    ok(setUrl[3] === "https://github.com/arzonic/agent-engine.git", "rewrites origin to the clean (token-free) URL");
    ok(!git.calls.some((c) => c[0] === "remote" && c.join(" ").includes(TOKEN)), "token never persists in origin");
  }

  console.log("\nensureWorkspace — refresh existing:");
  {
    const git = fakeGit((args) => {
      if (args[0] === "rev-parse") return { code: 0, output: "main\n" };
      return { code: 0, output: "" };
    });
    const res = await ensureWorkspace({
      root: wsRoot,
      owner: "arzonic",
      repo: "agent-engine",
      token: TOKEN,
      gitImpl: git.run,
      existsImpl: () => true,
    });
    ok(res.cloned === false, "reports a refresh, not a clone");
    ok(!git.calls.some((c) => c[0] === "clone"), "does not re-clone");
    ok(git.calls.some((c) => c[0] === "merge" && c.includes("--ff-only")), "fast-forwards only (no clobber)");
  }

  console.log("\nensureWorkspace — clone failure scrubs token:");
  {
    const git = fakeGit((args) =>
      args[0] === "clone" ? { code: 128, output: `fatal: auth with ${TOKEN} failed` } : { code: 0, output: "" },
    );
    let threw = "";
    try {
      await ensureWorkspace({ root: wsRoot, owner: "x", repo: "y", token: TOKEN, gitImpl: git.run, existsImpl: () => false });
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    ok(threw.length > 0, "throws on clone failure");
    ok(!threw.includes(TOKEN), "the error does NOT contain the token");
    ok(threw.includes("***"), "the token is replaced with ***");
  }

  await rm(wsRoot, { recursive: true, force: true });
  console.log("\n✅ verify-github-workspace: all checks passed");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
