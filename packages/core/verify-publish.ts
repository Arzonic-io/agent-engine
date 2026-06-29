/**
 * HERMETIC verify for the GitHub Publisher (overnight-trust "del b"). No network,
 * no real git, no LLM — git and fetch are both injected, so this runs in CI and
 * proves the publish decision logic end to end:
 *   • parseGitHubRemote across SSH / HTTPS / credentialed / non-GitHub URLs
 *   • opens a draft PR against the default branch (correct request shape)
 *   • idempotent: reuses an existing open PR instead of opening a duplicate
 *   • no-ops when the branch is not ahead of base (nothing to publish)
 *   • no-ops when there's no `origin` remote
 *   • surfaces a token-read failure as a clear note
 *   • SCRUBS the token from a push-failure error message
 *
 * Run: pnpm --filter @arzonic/agent-core exec tsx verify-publish.ts
 */
import type { GitResult } from "../shared/src/git.js";
import { createGitHubPublisher, parseGitHubRemote } from "../shared/src/publisher.js";
import { buildDigest } from "./src/humanPolicy.js";
import type { Mission } from "./src/mission.js";

const ok = (c: boolean, m: string) => {
  if (!c) throw new Error(`FAIL: ${m}`);
  console.log(`  ✓ ${m}`);
};

const TOKEN = "ghp_SUPERSECRETTOKEN1234567890";

const mission: Mission = {
  id: "m1",
  projectId: "p1",
  goal: "Add a health-check endpoint and cover it with a test",
  acceptanceCriteria: ["GET /health returns 200", "a test asserts the 200"],
  repoPath: "/tmp/fake-repo",
  status: "done",
  budget: null,
  spentTokens: 4242,
  deadline: null,
  guidance: null,
  iterations: 3,
  noProgress: 0,
  createdAt: new Date(1_700_000_000_000).toISOString(),
};
const digest = buildDigest(mission, []);
const BRANCH = "mission/m1/integration";

/** A fake git that answers each command from a script; records every call. */
function fakeGit(answers: Record<string, GitResult>) {
  const calls: string[][] = [];
  const run = async (_cwd: string, args: string[]): Promise<GitResult> => {
    calls.push(args);
    if (args[0] === "remote") return answers.remote ?? { code: 0, output: "git@github.com:arzonic/agent-engine.git\n" };
    if (args[0] === "rev-list") return answers.revlist ?? { code: 0, output: "2\n" };
    if (args[0] === "push") return answers.push ?? { code: 0, output: "" };
    return { code: 0, output: "" };
  };
  return { run, calls };
}

/** A fake fetch driven by a per-test handler; records requests. */
function fakeFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  const reqs: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    reqs.push({ url: u, init });
    const { status, body } = handler(u, init);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, reqs };
}

async function main(): Promise<void> {
  console.log("parseGitHubRemote:");
  ok(
    JSON.stringify(parseGitHubRemote("git@github.com:arzonic/agent-engine.git")) ===
      JSON.stringify({ host: "github.com", owner: "arzonic", repo: "agent-engine" }),
    "parses SSH form",
  );
  ok(
    JSON.stringify(parseGitHubRemote("https://github.com/arzonic/agent-engine")) ===
      JSON.stringify({ host: "github.com", owner: "arzonic", repo: "agent-engine" }),
    "parses HTTPS form without .git",
  );
  ok(
    JSON.stringify(parseGitHubRemote("https://x-access-token:tok@github.com/arzonic/agent-engine.git")) ===
      JSON.stringify({ host: "github.com", owner: "arzonic", repo: "agent-engine" }),
    "parses credentialed HTTPS form",
  );
  ok(parseGitHubRemote("/some/local/path") === null, "rejects a non-GitHub remote");

  console.log("\nopens a draft PR:");
  {
    const git = fakeGit({});
    const fetcher = fakeFetch((url, init) => {
      if (url.endsWith("/repos/arzonic/agent-engine")) return { status: 200, body: { default_branch: "main" } };
      if (url.includes("/pulls?head=")) return { status: 200, body: [] };
      if (init?.method === "POST") return { status: 201, body: { html_url: "https://github.com/arzonic/agent-engine/pull/7", number: 7 } };
      return { status: 404, body: "" };
    });
    const pub = createGitHubPublisher({ token: TOKEN, gitImpl: git.run, fetchImpl: fetcher.impl });
    const res = await pub.publish({ mission, branch: BRANCH, digest });
    ok(res.url === "https://github.com/arzonic/agent-engine/pull/7", "returns the PR url");
    ok(/draft PR #7/.test(res.note), "notes the draft PR number");
    const push = git.calls.find((c) => c[0] === "push")!;
    ok(push[1]!.includes(`x-access-token:${TOKEN}@github.com/arzonic/agent-engine.git`), "push uses the tokenised URL");
    ok(push[2] === `${BRANCH}:refs/heads/${BRANCH}`, "push uses the right refspec");
    const post = fetcher.reqs.find((r) => r.init?.method === "POST")!;
    const body = JSON.parse(String(post.init!.body));
    ok(body.head === BRANCH && body.base === "main" && body.draft === true, "PR targets default branch as a draft");
    ok(String(body.body).includes(mission.goal), "PR body includes the goal");
  }

  console.log("\nidempotent reuse:");
  {
    const git = fakeGit({});
    const fetcher = fakeFetch((url, init) => {
      if (url.endsWith("/repos/arzonic/agent-engine")) return { status: 200, body: { default_branch: "main" } };
      if (url.includes("/pulls?head=")) return { status: 200, body: [{ html_url: "https://github.com/arzonic/agent-engine/pull/3", number: 3 }] };
      if (init?.method === "POST") return { status: 201, body: { html_url: "SHOULD-NOT-HAPPEN", number: 99 } };
      return { status: 404, body: "" };
    });
    const pub = createGitHubPublisher({ token: TOKEN, gitImpl: git.run, fetchImpl: fetcher.impl });
    const res = await pub.publish({ mission, branch: BRANCH, digest });
    ok(res.url === "https://github.com/arzonic/agent-engine/pull/3", "reuses the existing PR url");
    ok(!fetcher.reqs.some((r) => r.init?.method === "POST"), "does NOT POST a new PR");
  }

  console.log("\nno-op when not ahead:");
  {
    const git = fakeGit({ revlist: { code: 0, output: "0\n" } });
    const fetcher = fakeFetch((url) =>
      url.endsWith("/repos/arzonic/agent-engine") ? { status: 200, body: { default_branch: "main" } } : { status: 404, body: "" },
    );
    const pub = createGitHubPublisher({ token: TOKEN, gitImpl: git.run, fetchImpl: fetcher.impl });
    const res = await pub.publish({ mission, branch: BRANCH, digest });
    ok(res.url === null && /no commits beyond main/.test(res.note), "returns null with a clear note");
    ok(!git.calls.some((c) => c[0] === "push"), "never pushes");
  }

  console.log("\nno origin remote:");
  {
    const git = fakeGit({ remote: { code: 1, output: "fatal: no such remote" } });
    const fetcher = fakeFetch(() => ({ status: 404, body: "" }));
    const pub = createGitHubPublisher({ token: TOKEN, gitImpl: git.run, fetchImpl: fetcher.impl });
    const res = await pub.publish({ mission, branch: BRANCH, digest });
    ok(res.url === null && /no 'origin' remote/.test(res.note), "returns null when origin is missing");
  }

  console.log("\ntoken-read failure:");
  {
    const git = fakeGit({});
    const fetcher = fakeFetch(() => ({ status: 404, body: "Not Found" }));
    const pub = createGitHubPublisher({ token: TOKEN, gitImpl: git.run, fetchImpl: fetcher.impl });
    const res = await pub.publish({ mission, branch: BRANCH, digest });
    ok(res.url === null && /check the token/.test(res.note), "surfaces a clear note on a 404 repo read");
  }

  console.log("\nscrubs the token on push failure:");
  {
    const git = fakeGit({ push: { code: 128, output: `remote: error using token ${TOKEN} denied` } });
    const fetcher = fakeFetch((url) =>
      url.endsWith("/repos/arzonic/agent-engine") ? { status: 200, body: { default_branch: "main" } } : { status: 404, body: "" },
    );
    const pub = createGitHubPublisher({ token: TOKEN, gitImpl: git.run, fetchImpl: fetcher.impl });
    let threw = "";
    try {
      await pub.publish({ mission, branch: BRANCH, digest });
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    ok(threw.length > 0, "throws on push failure");
    ok(!threw.includes(TOKEN), "the error message does NOT contain the token");
    ok(threw.includes("***"), "the token is replaced with ***");
  }

  console.log("\n✅ verify-publish: all checks passed");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
