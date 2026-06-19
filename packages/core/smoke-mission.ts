/**
 * END-TO-END SMOKE TEST for M2 — a REAL model authoring REAL code.
 *
 * Unlike the verify-*.ts proofs (which use scripted fake models), this drives the
 * full `runMission` controller loop with a LIVE LLM (from .env) against a throwaway
 * git repo: in-memory backlog → real worktree manager → real implementer graph
 * (ReAct loop with write-tools) → real Verifier → real git Integrator → real
 * replanner. It proves the plumbing carries actual water: the model must write a
 * file that makes a failing check pass, and that code must land — green — on the
 * mission branch.
 *
 * The fixture: a repo with a `test` script (`node test.js`) that fails until
 * `src/math.js` exports `add(a,b)`. Pure node builtins ⇒ no pnpm install needed.
 *
 * Run: pnpm --filter @arzonic/agent-core exec tsx smoke-mission.ts
 * Requires a working LLM in .env (LLM_PROVIDER + API key).
 */
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { MemorySaver } from "@langchain/langgraph";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv } from "../shared/src/env.js";
import { getModel } from "../shared/src/llm.js";
import { createVerifier } from "../shared/src/verifier.js";
import { createWritableRepoTools } from "../shared/src/repoTools.js";
import { createWorktreeManager } from "../shared/src/worktree.js";
import { createGitIntegrator, ensureGitBranch } from "../shared/src/integrator.js";
import { createImplementerGraph } from "./src/graph.js";
import { createWorktreeWorkRunner, type RunnableMissionGraph } from "./src/runner.js";
import { makeReplanner } from "./src/nodes/replan.js";
import { runMission, type MissionDeps } from "./src/controller.js";
import type { BacklogItem, BacklogStore, Mission } from "./src/mission.js";

const ok = (c: boolean, m: string) => {
  if (!c) throw new Error(`FAIL: ${m}`);
  console.log(`  ✓ ${m}`);
};
const g = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });

let seq = 0;
const iso = () => new Date(1_700_000_000_000 + seq++ * 1000).toISOString();

/** Minimal single-mission in-memory BacklogStore (same shape as verify-mission). */
function makeStore(mission: Mission, items: BacklogItem[]): BacklogStore {
  const missions = new Map([[mission.id, { ...mission }]]);
  const map = new Map(items.map((i) => [i.id, { ...i }]));
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
        id: `gen-${seq++}`,
        missionId: input.missionId,
        title: input.title,
        detail: input.detail ?? "",
        status: "todo",
        priority: input.priority ?? 0,
        dependsOn: input.dependsOn ?? [],
        risk: input.risk ?? "low",
        runId: null,
        verification: null,
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
  `\nSmoke test: live model = ${env.LLM_PROVIDER}/${env.LLM_MODEL ?? "(default)"} | checks = [test]\n`,
);

const repo = await mkdtemp(join(tmpdir(), "smoke-mission-"));
try {
  // ── Fixture: a repo whose `test` check fails until src/math.js exports add() ──
  g(repo, "init", "-q", "-b", "main");
  g(repo, "config", "user.email", "t@t.t");
  g(repo, "config", "user.name", "t");
  await writeFile(
    join(repo, "package.json"),
    JSON.stringify({ name: "smoke-fixture", scripts: { test: "node test.js" } }, null, 2) + "\n",
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
  await writeFile(join(repo, "README.md"), "# smoke fixture\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init: failing test, no implementation yet");

  // The mission branch the controller integrates onto.
  const missionId = "smoke1";
  const missionBranch = `mission/${missionId}/integration`;
  await ensureGitBranch(repo, missionBranch);
  g(repo, "checkout", "-q", "main");

  // ── Real seams (the exact ones the mission-worker wires in production) ──
  const worktrees = createWorktreeManager(repo);
  const allowedChecks = ["test"];
  const runner = createWorktreeWorkRunner({
    worktrees,
    baseRef: missionBranch,
    branch: (item) => `mission/${missionId}/item/${item.id}`,
    buildGraph: (wt) =>
      createImplementerGraph({
        model,
        checkpointer: new MemorySaver(),
        repo: createWritableRepoTools(wt.path, { allowedChecks }),
      }) as RunnableMissionGraph,
  });
  const verifier = createVerifier(repo, { allowedChecks });
  const integrator = createGitIntegrator(repo, { missionBranch, worktrees });
  const replanner = makeReplanner(model);

  const mission: Mission = {
    id: missionId,
    projectId: "p1",
    goal: "Make the test suite pass by implementing the math module.",
    acceptanceCriteria: ["`pnpm test` passes"],
    repoPath: repo,
    status: "running",
    budget: null,
    spentTokens: 0,
    deadline: null,
    createdAt: iso(),
  };
  const work: BacklogItem = {
    id: "impl-add",
    missionId,
    title: "Implement add(a, b) in src/math.js",
    detail:
      "Create a CommonJS module at src/math.js that exports a function `add(a, b)` " +
      "returning the numeric sum a + b (use `module.exports = { add }`). A test at " +
      "test.js already requires it. Run the `test` check and make it pass.",
    status: "todo",
    priority: 1,
    dependsOn: [],
    risk: "low",
    runId: null,
    verification: null,
    createdAt: iso(),
    updatedAt: iso(),
  };
  const store = makeStore(mission, [work]);

  const deps: MissionDeps = {
    backlog: store,
    verifier,
    runner,
    integrator,
    replanner,
    governors: { maxIterations: 6, thrashLimit: 3, concurrency: 1 },
    checks: allowedChecks,
  };

  console.log("Running mission (a live model is now authoring code — this can take a minute)…\n");
  const out = await runMission(deps, missionId);

  const item = (await store.listItems(missionId)).find((i) => i.id === "impl-add")!;
  console.log(`\nMission outcome: ${out.status} (${out.reason}) — ${out.itemsDone} done, ${out.iterations} iterations.`);
  const mTokens = (await store.getMission(missionId))!.spentTokens;
  console.log(`Tokens spent: ${mTokens}\n`);

  console.log("Assertions:");
  ok(out.status === "done", "mission finished DONE (the model solved it)");
  ok(out.itemsDone === 1, "the work item closed as done");
  ok(item.status === "done", "backlog item recorded as done");

  // The integrator leaves the main repo checked out on the mission branch.
  ok(existsSync(join(repo, "src/math.js")), "src/math.js was authored and merged onto the mission branch");
  const onMission = await verifier.run(allowedChecks);
  ok(onMission.passed, "the `test` check PASSES on the mission branch (real code, real check)");

  // Isolation: main never received the change directly.
  g(repo, "stash", "-u");
  g(repo, "checkout", "-q", "main");
  ok(!existsSync(join(repo, "src/math.js")), "main branch is untouched — change lives only on the mission branch");
  g(repo, "checkout", "-q", missionBranch);

  console.log("\n🎉 M2 end-to-end SMOKE TEST PASSED — the engine authored running code with a live model.\n");
} finally {
  await rm(repo, { recursive: true, force: true });
}
