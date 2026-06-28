/**
 * Throwaway proof of the four north-star "overnight trust" blockers, with in-memory
 * fakes — no DB, no LLM. Proves the parts that live in pure core:
 *   2  preemptive abort: an aborted in-flight run is RE-QUEUED cleanly (back to todo),
 *      never parked as a failure, and the loop stops with the right reason.
 *   3  strategic re-decompose: a drained backlog re-plans toward the goal up to the
 *      cap, then converges to "done" on an empty re-plan — and is OFF when the cap is 0.
 *   4a governor-counter persistence: iterations/no-progress are seeded from the row
 *      and written back, so the termination guarantee survives a restart.
 *
 * (Blocker 1's transport lives in shared — see verify-notifier.ts. Blocker 4b's live
 *  multi-item end-to-end run is smoke-mission-full.ts.)
 *
 * Run: pnpm --filter @arzonic/agent-core exec tsx verify-blockers.ts
 */
import {
  runMission,
  type Decomposer,
  type DecomposeInput,
  type MissionDeps,
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

function mission(over: Partial<Mission> = {}): Mission {
  return {
    id: "m1",
    projectId: "p1",
    goal: "Ship the thing",
    acceptanceCriteria: ["builds"],
    repoPath: "/tmp/repo",
    status: "running",
    budget: null,
    spentTokens: 0,
    deadline: null,
    roleModels: {},
    guidance: null,
    iterations: 0,
    noProgress: 0,
    createdAt: iso(),
    ...over,
  };
}

function item(id: string, priority = 0, dependsOn: string[] = []): BacklogItem {
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
const doneReplanner: Replanner = {
  async replan({ verification }) {
    return { itemStatus: verification.passed ? "done" : "todo" };
  },
};
const plainRunner: WorkRunner = {
  async run(it) {
    return { runId: it.id, status: "accepted", draft: `built ${it.id}`, verdict: null, tokensUsed: 10 };
  },
};

// ── Blocker 2: an aborted in-flight run is re-queued cleanly, not parked ──
{
  const m = mission();
  const store = makeStore(m, [item("a")]);
  const ac = new AbortController();
  // The runner simulates the worker's watcher: it flips the kill switch + aborts the
  // signal, then throws as the in-flight model call would when cancelled.
  const abortingRunner: WorkRunner = {
    async run() {
      await store.updateMission("m1", { status: "stopped" });
      ac.abort();
      throw new Error("The operation was aborted");
    },
  };
  const deps: MissionDeps = {
    backlog: store,
    verifier: passingVerifier,
    runner: abortingRunner,
    replanner: doneReplanner,
    // A NON-transient classifier: proves the abort path wins over the error/park path.
    isTransientError: () => false,
    signal: ac.signal,
    checks: ["test"],
  };
  const out = await runMission(deps, "m1");
  const a = (await store.listItems("m1"))[0]!;
  ok(out.status === "stopped" && out.reason === "stopped", "abort → mission stops with reason 'stopped'");
  ok(a.status === "todo", "aborted item is re-queued to todo (resume-safe), NOT parked");
  ok(a.verification === null, "aborted item carries no run-error verification (not a failure)");
  ok(out.itemsDone === 0, "an aborted item does not count as done");
}

// Contrast: the SAME throw without an aborted signal parks as a run-error (so the
// abort handling is genuinely distinct from the failure path, not a coincidence).
{
  const m = mission();
  const store = makeStore(m, [item("a")]);
  const throwingRunner: WorkRunner = {
    async run() {
      throw new Error("boom");
    },
  };
  const deps: MissionDeps = {
    backlog: store,
    verifier: passingVerifier,
    runner: throwingRunner,
    replanner: doneReplanner,
    isTransientError: () => false,
    checks: ["test"],
  };
  await runMission(deps, "m1");
  const a = (await store.listItems("m1"))[0]!;
  ok(
    a.status === "blocked_needs_human" && a.verification?.check === "run-error",
    "contrast: a non-aborted throw still parks as run-error (abort path is distinct)",
  );
}

// ── Blocker 3: strategic re-decompose extends a drained backlog toward the goal ──
{
  const m = mission();
  const store = makeStore(m, [item("seed")]);
  const continuationCalls: boolean[] = [];
  // 1st continuation re-plan adds one item; 2nd returns empty ⇒ converge to done.
  let replanRound = 0;
  const decomposer: Decomposer = {
    async decompose(input: DecomposeInput) {
      continuationCalls.push(!!input.continuation);
      replanRound++;
      if (input.continuation && replanRound === 1) {
        return { items: [{ key: "ext", title: "follow-up slice toward the goal" }], tokensUsed: 5 };
      }
      return { items: [] };
    },
  };
  const deps: MissionDeps = {
    backlog: store,
    verifier: passingVerifier,
    runner: plainRunner,
    replanner: doneReplanner,
    decomposer,
    governors: { maxStrategicReplans: 2 },
    checks: ["test"],
  };
  const out = await runMission(deps, "m1");
  ok(out.status === "done" && out.reason === "done", "strategic re-plan converges to done");
  ok(out.itemsDone === 2, "the seed item AND the strategically-added item both completed");
  ok(
    continuationCalls.length === 2 && continuationCalls.every((c) => c),
    "decompose was re-invoked with continuation=true (not the one-shot initial path)",
  );
}

// Gated OFF by default: with maxStrategicReplans=0 the drained backlog ends 'done'
// immediately and the decomposer is never re-invoked (exact pre-blocker-3 behaviour).
{
  const m = mission();
  const store = makeStore(m, [item("seed")]);
  let calls = 0;
  const decomposer: Decomposer = {
    async decompose() {
      calls++;
      return { items: [{ key: "ext", title: "should never be asked for" }] };
    },
  };
  const deps: MissionDeps = {
    backlog: store,
    verifier: passingVerifier,
    runner: plainRunner,
    replanner: doneReplanner,
    decomposer,
    governors: { maxStrategicReplans: 0 },
    checks: ["test"],
  };
  const out = await runMission(deps, "m1");
  // calls is 0: the backlog was pre-seeded (initial decompose skipped) AND strategic
  // re-plan is off — so the decomposer is never touched.
  ok(out.itemsDone === 1 && calls === 0, "maxStrategicReplans=0 → no re-plan, drain-and-stop");
}

// ── Blocker 4a: governor counters survive a restart ──
{
  // First run is capped at 2 iterations; it should persist iterations=2 on the row.
  const m = mission();
  const store = makeStore(m, [item("a", 3), item("b", 2), item("c", 1)]);
  const deps: MissionDeps = {
    backlog: store,
    verifier: passingVerifier,
    runner: plainRunner,
    replanner: doneReplanner,
    governors: { maxIterations: 2 },
    checks: ["test"],
  };
  const out1 = await runMission(deps, "m1");
  ok(out1.reason === "max-iterations", "first run stops at the iteration cap");
  const persisted = (await store.getMission("m1"))!.iterations;
  ok(persisted === 2, `iterations persisted on the row (=${persisted})`);

  // "Restart": flip back to running, raise the cap, re-run. The seeded counter must
  // CONTINUE from 2, not reset to 0 — so the 3rd item runs and iterations reaches 3.
  await store.updateMission("m1", { status: "running" });
  const out2 = await runMission({ ...deps, governors: { maxIterations: 4 } }, "m1");
  const after = (await store.getMission("m1"))!.iterations;
  ok(out2.itemsDone === 1, "restart completes exactly the remaining item");
  ok(after === 3, `iterations continued across restart (=${after}, not reset to 1)`);
}

// A persisted counter already at the cap stops a resumed mission immediately —
// the termination guarantee genuinely survives the restart.
{
  const m = mission({ iterations: 5 });
  const store = makeStore(m, [item("a")]);
  const out = await runMission(
    {
      backlog: store,
      verifier: passingVerifier,
      runner: plainRunner,
      replanner: doneReplanner,
      governors: { maxIterations: 4 },
      checks: ["test"],
    },
    "m1",
  );
  ok(
    out.reason === "max-iterations" && out.itemsDone === 0,
    "a resumed mission already over its iteration cap stops at once (no fresh budget)",
  );
}

console.log("\n🎉 verify-blockers PASSED — abort-requeue, strategic re-plan, counter persistence.\n");
