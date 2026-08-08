/**
 * HERMETIC verify for the GitHub issues client (start-a-mission-from-an-issue).
 * No network — `fetch` is injected — so this runs in CI and proves:
 *   • the issues endpoint is hit with state=open on the right repo
 *   • pull requests (which the endpoint mixes in) are filtered OUT
 *   • labels normalise across the string and object forms; a null body → ""
 *   • a non-2xx surfaces a clear error
 *
 * Run: pnpm --filter @arzonic/agent-shared exec tsx verify-github.ts
 */
import { listGitHubIssues } from "./src/github.js";

const ok = (c: boolean, m: string) => {
  if (!c) throw new Error(`FAIL: ${m}`);
  console.log(`  ✓ ${m}`);
};

/** A fake fetch that returns a fixed payload and records the requested URLs. */
function fakeFetch(status: number, body: unknown) {
  const urls: string[] = [];
  const impl = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, urls };
}

async function main(): Promise<void> {
  console.log("listGitHubIssues:");
  {
    const rows = [
      { number: 5, title: "Real issue", body: "do it", html_url: "https://x/5", labels: [{ name: "bug" }, "chore"] },
      { number: 6, title: "A PR, not an issue", body: null, html_url: "https://x/6", labels: [], pull_request: { url: "..." } },
      { number: 7, title: "No body", body: null, html_url: "https://x/7", labels: [] },
    ];
    const { impl, urls } = fakeFetch(200, rows);
    const issues = await listGitHubIssues({ token: "t", owner: "arzonic", repo: "agent-engine", fetchImpl: impl });

    ok(urls[0]!.includes("/repos/arzonic/agent-engine/issues"), "hits the repo's issues endpoint");
    ok(urls[0]!.includes("state=open"), "requests only open issues");
    ok(issues.length === 2, "filters out the pull request (2 of 3 rows kept)");
    ok(!issues.some((i) => i.number === 6), "the PR row is gone");
    ok(JSON.stringify(issues[0]!.labels) === JSON.stringify(["bug", "chore"]), "labels normalise across object+string forms");
    ok(issues.find((i) => i.number === 7)!.body === "", "a null body becomes an empty string");
  }

  console.log("\nerror surfacing:");
  {
    const { impl } = fakeFetch(404, "Not Found");
    let threw = "";
    try {
      await listGitHubIssues({ token: "t", owner: "a", repo: "b", fetchImpl: impl });
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    ok(/HTTP 404/.test(threw), "a non-2xx throws with the status");
  }

  console.log("\n✅ verify-github: all checks passed");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
