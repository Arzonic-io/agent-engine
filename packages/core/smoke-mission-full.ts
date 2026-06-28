/**
 * FULL-STACK END-TO-END SMOKE TEST (blocker 4b) — the exact production composition
 * the mission-worker wires, driven by a LIVE model against a throwaway git repo.
 *
 * Unlike smoke-mission.ts (which deliberately ran the BARE implementer for one
 * hand-seeded item), this exercises the stack that actually runs overnight and had
 * never been run end-to-end together:
 *   • decompose-from-EMPTY-backlog  (the mission plans its own work from the goal)
 *   • createMissionTeamGraph        (implementer → critic → revise, reviewRounds=1)
 *   • TestAuthor                     (authors a test exercising the change, MISSION_AUTHOR_TESTS on)
 *   • createGitIntegrator + Differ  (merge → re-verify on the mission branch, capture the diff)
 *   • makeReplanner                 (done / follow-ups)
 *   • strategic re-plan at idle      (maxStrategicReplans > 0 — converges on an empty re-plan)
 *
 * It is a LIVE harness (needs LLM_PROVIDER + an API key in .env) and costs real
 * tokens, so it is NOT in CI — run it by hand to convert "every seam is green" into
 * "the production stack carries water". Multi-item dependency + concurrency +
 * integration ordering are proven hermetically in verify-mission.ts; this proves the
 * real composition runs with a real model.
 *
 * Run: pnpm --filter @arzonic/agent-core exec tsx smoke-mission-full.ts
 */
import { MemorySaver } from "@langchain/langgraph";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv } from "../shared/src/env.js";
import { getModel } from "../shared/src/llm.js";
import { createVerifier } from "../shared/src/verifier.js";
import { createWritableRepoTools } from "../shared/src/repoTools.js";
import { createWorktreeManager } from "../shared/src/worktree.js";
import { createGitDiffer } from "../shared/src/differ.js";
import { createConsoleNotifier } from "../shared/src/notifier.js";
import { createGitIntegrator, ensureGitBranch } from "../shared/src/integrator.js";
import { createMissionTeamGraph } from "./src/graph.js";
import { createWorktreeWorkRunner, type RunnableMissionGraph } from "./src/runner.js";
import { makeReplanner } from "./src/nodes/replan.js";
import { makeDecomposer } from "./src/nodes/decompose.js";
import { makeTestAuthor } from "./src/nodes/testAuthor.js";
import { buildDigest } from "./src/humanPolicy.js";
import { runMission, type MissionDeps } from "./src/controller.js";
import type { BacklogItem, BacklogStore, Mission } from "./src/mission.js";

const ok = (c: boolean, m: string) => {
  if (!c) throw new Error(`FAIL: ${m}`);
  console.log(`  ✓ ${m}`);
};
const g = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });

let seq = 0;
const iso = () => new Date(1_700_000_000_000 + seq++ * 1000).toISOString();

/** In-memory single-mission BacklogStore — starts EMPTY so the decomposer plans it. */
function makeStore(mission: Mission): BacklogStore {
  const missions = new Map([[mission.id, { ...mission }]]);
  const map = new Map<string, BacklogItem>();
  return {
    async createMission() {
      throw new Error("unused");
    },
    async getMission(id) {
      const m = missions.get(id);
      return m ? { ...m } : null;
    },
    async listMissions() {
      return [...missions.values()];
    },
    async updateMission(id, patch) {
      const m = missions.get(id);
      if (!m) return null;
      Object.assign(m, patch);
      return { ...m };
    },
    async createItem(input) {
      const it: BacklogItem = {
        id: `item-${seq++}`,
        missionId: input.missionId,
        title: input.title,
        detail: input.detail ?? "",
        status: "todo",
        priority: input.priority ?? 0,
        dependsOn: input.dependsOn ?? [],
        risk: input.risk ?? "low",
        runId: null,
        verification: null,
        diff: null,
        createdAt: iso(),
        updatedAt: iso(),
      };
      map.set(it.id, it);
      return { ...it };
    },
    async getItem(id) {
      const i = map.get(id);
      return i ? { ...i } : null;
    },
    async listItems() {
      return [...map.values()].sort(
        (a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt),
      );
    },
    async updateItem(id, patch) {
      const i = map.get(id);
      if (!i) return null;
      Object.assign(i, patch, { updatedAt: iso() });
      return { ...i };
    },
    async nextActionable(missionId) {
      const candidates = [...map.values()]
        .filter((i) => i.missionId === missionId && i.status === "todo")
        .filter((i) => i.dependsOn.every((d) => map.get(d)?.status === "done"))
        .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
      return candidates[0] ? { ...candidates[0]! } : null;
    },
  };
}

const env = loadEnv();
const model = getModel(env);
console.log(
  `\nFull-stack smoke: live model = ${env.LLM_PROVIDER}/${env.LLM_MODEL ?? "(default)"} | ` +
    `stack = decompose + team(critic) + tester + integrate + differ + strategic-replan\n`,
);

const repo = await mkdtemp(join(tmpdir(), "smoke-full-"));
try {
  // ── Fixture: a repo whose `test` check fails until src/math.js exports add() ──
  g(repo, "init", "-q", "-b", "main");
  g(repo, "config", "user.email", "t@t.t");
  g(repo, "config", "user.name", "t");
  await writeFile(
    join(repo, "package.json"),
    JSON.stringify({ name: "smoke-full-fixture", scripts: { test: "node test.js" } }, null, 2) + "\n",
  );
  await writeFile(
    join(repo, "test.js"),
    [
      "const assert = require('node:assert');",
      "const { add } = require('./src/math.js');",
      "assert.strictEqual(add(2, 3), 5, 'add(2,3) should be 5');",
      "assert.strictEqual(add(-1, 1), 0, 'add(-1,1) should be 0');",
      "console.log('math test passed');",
      "",
    ].join("\n"),
  );
  await writeFile(join(repo, "README.md"), "# smoke full fixture\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init: failing test, no implementation yet");

  const missionId = "smoke-full";
  const missionBranch = `mission/${missionId}/integration`;
  await ensureGitBranch(repo, missionBranch);
  g(repo, "checkout", "-q", "main");

  // ── The EXACT production seams the mission-worker wires ──
  const worktrees = createWorktreeManager(repo);
  const allowedChecks = ["test"];
  const repoFor = (path: string) => createWritableRepoTools(path, { allowedChecks });

  const runner = createWorktreeWorkRunner({
    worktrees,
    baseRef: missionBranch,
    branch: (item) => `mission/${missionId}/item/${item.id}`,
    buildGraph: (wt) =>
      createMissionTeamGraph({
        model,
        checkpointer: new MemorySaver(),
        repo: repoFor(wt.path),
        reviewRounds: 1,
      }) as RunnableMissionGraph,
  });
  const verifier = createVerifier(repo, { allowedChecks });
  const integrator = createGitIntegrator(repo, { missionBranch, worktrees });
  const differ = createGitDiffer();
  const decomposer = makeDecomposer(model);
  const testAuthor = makeTestAuthor(model, { repo: repoFor });
  const replanner = makeReplanner(model);
  const notifier = createConsoleNotifier();

  const mission: Mission = {
    id: missionId,
    projectId: "p1",
    goal:
      "Create a CommonJS module at src/math.js that exports a function add(a, b) returning " +
      "the numeric sum a + b (module.exports = { add }). A test at test.js already requires it. " +
      "Make the `test` check pass.",
    acceptanceCriteria: ["`node test.js` passes"],
    repoPath: repo,
    status: "running",
    budget: null,
    spentTokens: 0,
    deadline: null,
    roleModels: {},
    guidance: null,
    iterations: 0,
    noProgress: 0,
    createdAt: iso(),
  };
  const store = makeStore(mission); // EMPTY backlog → the decomposer must plan it

  const deps: MissionDeps = {
    backlog: store,
    verifier,
    runner,
    integrator,
    differ,
    decomposer,
    testAuthor, // MISSION_AUTHOR_TESTS-equivalent: ON
    replanner,
    notifier,
    clock: { now: () => Date.now() },
    governors: { maxIterations: 12, thrashLimit: 3, concurrency: 1, maxStrategicReplans: 2 },
    isTransientError: () => false,
    checks: allowedChecks,
  };

  console.log("Running the full mission (decompose → build → critic → test → integrate)…\n");
  const out = await runMission(deps, missionId);

  const items = await store.listItems(missionId);
  const done = items.filter((i) => i.status === "done");
  console.log(`\nOutcome: ${out.status} (${out.reason}) — ${out.itemsDone} done, ${out.iterations} iterations.`);
  console.log(`Backlog (${items.length}): ${items.map((i) => `${i.title} [${i.status}]`).join(" | ")}`);
  const digest = buildDigest((await store.getMission(missionId))!, items);
  console.log(`Digest: ${digest.done.length} done · ${digest.parked.length} parked · ${digest.spentTokens} tokens\n`);

  console.log("Assertions:");
  ok(items.length >= 1, "the decomposer planned the backlog from the goal (empty → ≥1 item)");
  ok(done.length >= 1, "at least one item completed through the team+tester+integrate stack");
  ok(existsSync(join(repo, "src/math.js")), "src/math.js was authored and merged onto the mission branch");
  const onMission = await verifier.run(allowedChecks);
  ok(onMission.passed, "the `test` check PASSES on the mission branch (real code, real check, real model)");
  ok(
    out.status === "done" || out.status === "blocked",
    "the mission converged to a terminal state (done, or blocked awaiting a human) — never an infinite loop",
  );

  console.log("\n🎉 FULL-STACK SMOKE PASSED — the production composition carries water with a live model.\n");
} finally {
  await rm(repo, { recursive: true, force: true });
}
