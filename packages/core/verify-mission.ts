/**
 * Throwaway proof of the runMission controller loop (build-order Trin 4) with
 * in-memory fakes — no DB, no LLM. Proves the loop: respects priority +
 * dependsOn, closes verified items as done, ends "done" when all resolve, parks
 * to "blocked" on a dependency deadlock, and that every governor provably stops
 * it (max-iterations, budget, no-progress) with a recorded reason — plus resume
 * (a crashed in_progress item is requeued).
 * Run: pnpm --filter @arzonic/agent-core exec tsx verify-mission.ts
 */
import {
  runMission,
  type Differ,
  type Integrator,
  type MissionDeps,
  type MissionEvent,
  type Notifier,
  type Replanner,
} from "./src/controller.js";
import type {
  BacklogItem,
  BacklogStore,
  CreateBacklogItemInput,
  Mission,
} from "./src/mission.js";
import type { WorkRunner } from "./src/runner.js";
import type { Verifier, VerifierReport } from "./src/verifier.js";

const ok = (c: boolean, m: string) => {
  if (!c) throw new Error(`FAIL: ${m}`);
  console.log(`ok: ${m}`);
};

let seq = 0;
const iso = () => new Date(1_700_000_000_000 + seq++ * 1000).toISOString();

/** Minimal in-memory BacklogStore matching the core interface. */
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
    async createItem(input: CreateBacklogItemInput) {
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

const baseMission: Mission = {
  id: "m1",
  projectId: "p1",
  goal: "Ship the thing",
  acceptanceCriteria: ["builds", "tests pass"],
  repoPath: "/tmp/repo",
  status: "running",
  budget: null,
  spentTokens: 0,
  deadline: null,
  createdAt: iso(),
};

function item(id: string, priority: number, dependsOn: string[] = []): BacklogItem {
  return {
    id,
    missionId: "m1",
    title: `do ${id}`,
    detail: "",
    status: "todo",
    priority,
    dependsOn,
    risk: "low",
    runId: null,
    verification: null,
    diff: null,
    createdAt: iso(),
    updatedAt: iso(),
  };
}

const passingVerifier: Verifier = {
  async run(checks): Promise<VerifierReport> {
    return { passed: true, results: checks.map((c) => ({ passed: true, check: c, output: "" })) };
  },
};
const failingVerifier: Verifier = {
  async run(checks): Promise<VerifierReport> {
    return { passed: false, results: checks.map((c) => ({ passed: false, check: c, output: "boom" })) };
  },
};
const runner: WorkRunner = {
  async run(it) {
    return { runId: it.id, status: "accepted", draft: `built ${it.id}`, verdict: null, tokensUsed: 100 };
  },
};
// Unlike defaultReplanner (which fails an item outright), this one retries on a
// failed check — the behaviour the thrash guard is there to bound.
const retryReplanner: Replanner = {
  async replan({ verification }) {
    return { itemStatus: verification.passed ? "done" : "todo" };
  },
};

// ── 1. Happy path: priority + dependsOn order, ends done ──
{
  const order: string[] = [];
  const tracking: WorkRunner = {
    async run(it) {
      order.push(it.id);
      return runner.run(it);
    },
  };
  const store = makeStore({ ...baseMission }, [
    item("a", 10),
    item("b", 5, ["a"]), // depends on a
    item("c", 8), // higher priority than b, no deps
  ]);
  const deps: MissionDeps = { backlog: store, verifier: passingVerifier, runner: tracking };
  const out = await runMission(deps, "m1");
  ok(out.status === "done" && out.reason === "done", "all verified ⇒ mission done");
  ok(out.itemsDone === 3, "every item closed as done");
  ok(order.join(",") === "a,c,b", `order respects priority then dependsOn (got ${order.join(",")})`);
  ok((await store.getMission("m1"))!.spentTokens === 300, "spentTokens accumulated (3×100)");
}

// ── 2. Dependency deadlock ⇒ blocked ──
{
  const store = makeStore({ ...baseMission }, [item("x", 1, ["missing"])]);
  const out = await runMission({ backlog: store, verifier: passingVerifier, runner }, "m1");
  ok(out.status === "blocked", "item depending on an unsatisfiable id ⇒ blocked, not infinite loop");
}

// ── 3. no-progress governor (failing verifier never closes anything) ──
{
  const store = makeStore({ ...baseMission }, [item("a", 3), item("b", 2), item("c", 1)]);
  const out = await runMission(
    { backlog: store, verifier: failingVerifier, runner, governors: { noProgressLimit: 2 } },
    "m1",
  );
  ok(out.status === "stopped" && out.reason === "no-progress", "failing items trip the no-progress governor");
  ok(out.iterations === 2, "stopped after exactly noProgressLimit iterations");
}

// ── 4. max-iterations governor ──
{
  const store = makeStore({ ...baseMission }, [item("a", 3), item("b", 2), item("c", 1)]);
  const out = await runMission(
    { backlog: store, verifier: passingVerifier, runner, governors: { maxIterations: 2 } },
    "m1",
  );
  ok(out.reason === "max-iterations" && out.iterations === 2, "max-iterations stops the loop");
}

// ── 5. budget governor ──
{
  const store = makeStore({ ...baseMission, budget: 50 }, [item("a", 2), item("b", 1)]);
  const out = await runMission({ backlog: store, verifier: passingVerifier, runner }, "m1");
  ok(out.reason === "budget", "token budget stops the loop");
  ok(out.itemsDone === 1, "stopped once spend (100) crossed the 50 budget — one item ran");
}

// ── 6. resume: a crashed in_progress item is requeued and completed ──
{
  const stuck = item("a", 1);
  stuck.status = "in_progress"; // simulate a crash mid-run
  const store = makeStore({ ...baseMission }, [stuck]);
  const out = await runMission({ backlog: store, verifier: passingVerifier, runner }, "m1");
  ok(out.status === "done" && out.itemsDone === 1, "in_progress item requeued on resume and finished");
}

// ── 7. kill switch: mission already stopped ⇒ loop halts immediately, digest delivered ──
{
  // A human clicking Stop flips status off `running`; the loop must STILL deliver
  // the morning digest (M3 Trin 6) on that exit, not only on controller-driven ends.
  const events: MissionEvent["type"][] = [];
  const notifier: Notifier = {
    notify(e) {
      events.push(e.type);
    },
  };
  const store = makeStore({ ...baseMission, status: "stopped" }, [item("a", 1)]);
  const out = await runMission({ backlog: store, verifier: passingVerifier, runner, notifier }, "m1");
  ok(out.iterations === 0 && out.status === "stopped", "non-running mission halts before any work");
  ok(events.includes("mission_digest"), "the morning digest IS delivered when a human stops the mission");
  ok(events.includes("mission_stopped"), "the stop event is delivered on the human-stop exit too");
}

// ── 8. thrash guard: a repeatedly-failing item is PARKED, not retried forever ──
{
  const store = makeStore({ ...baseMission }, [item("stuck", 5), item("ok", 1)]);
  const out = await runMission(
    {
      backlog: store,
      // Everything fails; the retry replanner keeps re-queuing, so the guard
      // (not the replanner) is what eventually parks the item.
      verifier: failingVerifier,
      runner,
      replanner: retryReplanner,
      governors: { thrashLimit: 2, noProgressLimit: 99 }, // isolate thrash from no-progress
    },
    "m1",
  );
  const stuck = (await store.listItems("m1")).find((i) => i.id === "stuck")!;
  ok(stuck.status === "blocked_needs_human", "item that fails thrashLimit times is parked for a human");
  ok(out.status === "blocked", "with everything parked, the mission ends blocked (not an infinite loop)");
}

// ── 9. thrash parks only the stuck item; other work still completes ──
{
  // 'stuck' (higher priority) runs first and fails its only verification, so
  // with thrashLimit 1 it parks immediately; 'good' then verifies and completes.
  const store = makeStore({ ...baseMission }, [item("stuck", 5), item("good", 1)]);
  let firstRun = true;
  const flip: Verifier = {
    async run(checks): Promise<VerifierReport> {
      const passed = !firstRun; // only the first verification (the 'stuck' run) fails
      firstRun = false;
      return { passed, results: checks.map((c) => ({ passed, check: c, output: passed ? "" : "x" })) };
    },
  };
  const out = await runMission(
    { backlog: store, verifier: flip, runner, governors: { thrashLimit: 1 } },
    "m1",
  );
  const items = await store.listItems("m1");
  const parked = items.filter((i) => i.status === "blocked_needs_human").length;
  const done = items.filter((i) => i.status === "done").length;
  ok(parked === 1 && done === 1, "stuck item parked on first failure, the other still completed");
  ok(out.status === "blocked", "mission ends blocked because a parked item remains");
}

// ── 10. human policy: a high-risk item is parked BEFORE it ever runs ──
{
  const ran: string[] = [];
  const tracking: WorkRunner = {
    async run(it) {
      ran.push(it.id);
      return runner.run(it);
    },
  };
  const store = makeStore({ ...baseMission }, [
    item("safe", 1),
    { ...item("danger", 5), title: "Deploy to production" }, // high-risk, higher priority
  ]);
  const out = await runMission({ backlog: store, verifier: passingVerifier, runner: tracking }, "m1");
  const danger = (await store.listItems("m1")).find((i) => i.id === "danger")!;
  ok(danger.status === "blocked_needs_human", "high-risk item parked for a human");
  ok(!ran.includes("danger"), "the high-risk item NEVER ran (parked before execution)");
  ok(ran.includes("safe"), "the low-risk item still ran — the loop didn't block");
  ok(out.status === "blocked", "mission ends blocked with the parked item awaiting a decision");
}

// ── 11–13. integration (Trin 5): done requires green AFTER merge ──

// A runner that ran write-capably: it reports the item's worktree + branch.
const worktreeRunner: WorkRunner = {
  async run(it) {
    return {
      runId: it.id,
      status: "accepted",
      draft: `built ${it.id}`,
      verdict: null,
      tokensUsed: 100,
      worktree: `/wt/${it.id}`,
      branch: `mission/m/item/${it.id}`,
    };
  },
};

function fakeIntegrator(opts: { conflict?: boolean } = {}) {
  const calls = { merge: [] as string[], rollback: 0, cleanup: [] as string[] };
  const integrator: Integrator = {
    async merge({ branch }) {
      calls.merge.push(branch);
      return { merged: !opts.conflict, output: opts.conflict ? "CONFLICT" : "ok" };
    },
    async rollback() {
      calls.rollback++;
    },
    async cleanup(id) {
      calls.cleanup.push(id);
    },
  };
  return { integrator, calls };
}

// 11. happy path: worktree-green item merges + re-verifies green ⇒ done, cleaned up.
{
  const store = makeStore({ ...baseMission }, [item("a", 1)]);
  const { integrator, calls } = fakeIntegrator();
  const out = await runMission(
    { backlog: store, verifier: passingVerifier, runner: worktreeRunner, integrator },
    "m1",
  );
  const a = (await store.listItems("m1")).find((i) => i.id === "a")!;
  ok(out.status === "done" && a.status === "done", "merge + green re-verify ⇒ item done");
  ok(calls.merge[0] === "mission/m/item/a", "the item's branch was merged into the mission branch");
  ok(calls.cleanup.includes("a") && calls.rollback === 0, "successful integration cleans up, never rolls back");
}

// 12. merge conflict ⇒ parked for a human (not done), nothing cleaned up.
{
  const store = makeStore({ ...baseMission }, [item("a", 1)]);
  const { integrator, calls } = fakeIntegrator({ conflict: true });
  const out = await runMission(
    { backlog: store, verifier: passingVerifier, runner: worktreeRunner, integrator },
    "m1",
  );
  const a = (await store.listItems("m1")).find((i) => i.id === "a")!;
  ok(a.status === "blocked_needs_human", "a merge conflict parks the item for a human");
  ok(out.itemsDone === 0 && out.status === "blocked", "a conflicting item is NOT counted done");
  ok(calls.cleanup.length === 0 && calls.rollback === 0, "no cleanup/rollback when the merge itself failed");
  ok(a.verification?.passed === false, "the parked item records the integration failure");
}

// 13. green in isolation but RED after merge ⇒ rollback + park (mission branch stays green).
{
  // Passes when checks run in a worktree (cwd set), fails on the post-merge
  // re-verify in the main repo (cwd undefined): two greens summing to red.
  const splitVerifier: Verifier = {
    async run(checks, cwd): Promise<VerifierReport> {
      const passed = cwd !== undefined;
      return { passed, results: checks.map((c) => ({ passed, check: c, output: passed ? "" : "integration red" })) };
    },
  };
  const store = makeStore({ ...baseMission }, [item("a", 1)]);
  const { integrator, calls } = fakeIntegrator();
  const out = await runMission(
    { backlog: store, verifier: splitVerifier, runner: worktreeRunner, integrator, governors: { thrashLimit: 5 } },
    "m1",
  );
  const a = (await store.listItems("m1")).find((i) => i.id === "a")!;
  ok(calls.merge.length === 1 && calls.rollback === 1, "a red post-merge build is rolled back");
  ok(calls.cleanup.length === 0, "a rolled-back item's worktree is NOT cleaned up");
  ok(a.status === "blocked_needs_human" && out.itemsDone === 0, "integration-breaking item is parked, not done");
}

// 14. backward-compat: no integrator ⇒ worktree-green is enough for done.
{
  const store = makeStore({ ...baseMission }, [item("a", 1)]);
  const out = await runMission(
    { backlog: store, verifier: passingVerifier, runner: worktreeRunner },
    "m1",
  );
  ok(out.status === "done" && out.itemsDone === 1, "without an integrator, a verified item still closes (planning mode)");
}

// ── 15. parallelism (Trin 6): concurrent execution, SEQUENTIAL integration ──
{
  let active = 0;
  let maxActive = 0;
  const concurrentRunner: WorkRunner = {
    async run(it) {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10)); // hold the overlap window open
      active--;
      return {
        runId: it.id, status: "accepted", draft: "", verdict: null, tokensUsed: 100,
        worktree: `/wt/${it.id}`, branch: `mission/m/item/${it.id}`,
      };
    },
  };
  let merging = false;
  let mergesStayedSerial = true;
  const integrator: Integrator = {
    async merge() {
      if (merging) mergesStayedSerial = false; // a second merge entered while one was live
      merging = true;
      await new Promise((r) => setTimeout(r, 5));
      merging = false;
      return { merged: true, output: "ok" };
    },
    async rollback() {},
    async cleanup() {},
  };
  const store = makeStore({ ...baseMission }, [item("a", 1), item("b", 1), item("c", 1)]);
  const out = await runMission(
    { backlog: store, verifier: passingVerifier, runner: concurrentRunner, integrator, governors: { concurrency: 3 } },
    "m1",
  );
  ok(maxActive >= 2, `independent items execute concurrently (${maxActive} ran at once)`);
  ok(mergesStayedSerial, "integration stayed sequential — no two merges overlapped on the shared branch");
  ok(out.status === "done" && out.itemsDone === 3, "all concurrent items integrated + done");
}

// ── 16. dependencies hold even under concurrency: a dep never runs before its parent ──
{
  const order: string[] = [];
  const trackingRunner: WorkRunner = {
    async run(it) {
      order.push(it.id);
      return {
        runId: it.id, status: "accepted", draft: "", verdict: null, tokensUsed: 100,
        worktree: `/wt/${it.id}`, branch: `mission/m/item/${it.id}`,
      };
    },
  };
  const store = makeStore({ ...baseMission }, [item("a", 1), item("b", 1, ["a"]), item("c", 1)]);
  const { integrator } = fakeIntegrator();
  const out = await runMission(
    { backlog: store, verifier: passingVerifier, runner: trackingRunner, integrator, governors: { concurrency: 3 } },
    "m1",
  );
  ok(order.indexOf("a") < order.indexOf("b"), "a dependent (b) never runs in the same batch as its parent (a)");
  ok(out.status === "done" && out.itemsDone === 3, "all items done with dependencies respected under concurrency");
}

// ── 17. differ (Trin 5): the authored diff is captured + persisted on the item ──
{
  const fakeDiff = {
    files: [{ path: "src/x.ts", status: "added" as const, additions: 3, deletions: 0 }],
    additions: 3,
    deletions: 0,
    patch: "diff --git a/src/x.ts b/src/x.ts\n+a\n+b\n+c\n",
    truncated: false,
  };
  const seen: string[] = [];
  const differ: Differ = {
    async diff(worktree) {
      seen.push(worktree);
      return fakeDiff;
    },
  };
  const store = makeStore({ ...baseMission }, [item("a", 1)]);
  const { integrator } = fakeIntegrator();
  const out = await runMission(
    { backlog: store, verifier: passingVerifier, runner: worktreeRunner, integrator, differ },
    "m1",
  );
  const a = (await store.listItems("m1")).find((i) => i.id === "a")!;
  ok(out.status === "done", "mission still completes with a differ wired in");
  ok(seen[0] === "/wt/a", "the differ was called on the item's worktree");
  ok(JSON.stringify(a.diff) === JSON.stringify(fakeDiff), "the captured diff is persisted on the item");
}

// 18. no worktree (planning runner) ⇒ no diff captured (the guard holds).
{
  let called = false;
  const differ: Differ = {
    async diff(wt) {
      called = true;
      return { files: [], additions: 0, deletions: 0, patch: "", truncated: false };
    },
  };
  const store = makeStore({ ...baseMission }, [item("a", 1)]);
  const out = await runMission({ backlog: store, verifier: passingVerifier, runner, differ }, "m1");
  const a = (await store.listItems("m1")).find((i) => i.id === "a")!;
  ok(out.status === "done" && !called, "no worktree ⇒ the differ is never called");
  ok(a.diff === null, "no diff is stored when the item ran without a worktree");
}

// 19. a throwing differ never strands the item (best-effort capture).
{
  const differ: Differ = {
    async diff() {
      throw new Error("git exploded");
    },
  };
  const store = makeStore({ ...baseMission }, [item("a", 1)]);
  const { integrator } = fakeIntegrator();
  const out = await runMission(
    { backlog: store, verifier: passingVerifier, runner: worktreeRunner, integrator, differ },
    "m1",
  );
  const a = (await store.listItems("m1")).find((i) => i.id === "a")!;
  ok(out.status === "done" && a.status === "done", "a throwing differ does not strand the item — it still completes");
  ok(a.diff === null, "a failed diff capture leaves diff null, never a partial");
}

console.log("\nrunMission controller loop verified ✓");
