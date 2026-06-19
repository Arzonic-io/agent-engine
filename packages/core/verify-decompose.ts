/**
 * Throwaway proof for the M3 Trin 1 Decomposer — a mission grows its OWN initial
 * backlog from the goal, instead of being hand-seeded. In-memory fakes, no DB, no
 * LLM. Proves: decompose runs only on an EMPTY backlog (idempotent on resume),
 * key-based dependencies resolve to real ids, the guards make a malformed plan
 * safe, decompose tokens fold into the mission budget, and the whole thing drives
 * runMission end-to-end (goal → backlog → items done) with dependency order kept.
 * Run: pnpm --filter @arzonic/agent-core exec tsx verify-decompose.ts
 */
import {
  createDecomposedItems,
  runMission,
  type Decomposer,
  type MissionDeps,
} from "./src/controller.js";
import { applyDecomposeGuards, type DecomposeOutput } from "./src/nodes/decompose.js";
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
    async deleteMission(id) {
      missions.delete(id);
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
  goal: "Build the thing",
  acceptanceCriteria: ["builds", "tests pass"],
  repoPath: "/tmp/repo",
  status: "running",
  budget: null,
  spentTokens: 0,
  deadline: null,
  createdAt: iso(),
};

const passingVerifier: Verifier = {
  async run(checks): Promise<VerifierReport> {
    return { passed: true, results: checks.map((c) => ({ passed: true, check: c, output: "" })) };
  },
};
const runner: WorkRunner = {
  async run(it) {
    return { runId: it.id, status: "accepted", draft: `built ${it.id}`, verdict: null, tokensUsed: 100 };
  },
};

// A scripted decomposer: two items, the second depending on the first by KEY.
function scriptedDecomposer(items: DecomposeOutput["items"], tokens = 42): Decomposer {
  return {
    async decompose() {
      return applyDecomposeGuards({ items, reasoning: "scripted plan" }, tokens);
    },
  };
}

// ── 1. createDecomposedItems resolves key-based deps to real ids ──
{
  const store = makeStore({ ...baseMission }, []);
  const created = await createDecomposedItems(store, "m1", [
    { key: "schema", title: "Add schema", priority: 10 },
    { key: "api", title: "Add API", priority: 5, dependsOn: ["schema"] },
    { key: "ui", title: "Add UI", priority: 1, dependsOn: ["api", "schema"] },
  ]);
  ok(created.length === 3, "all three items created");
  const api = created.find((i) => i.title === "Add API")!;
  const schema = created.find((i) => i.title === "Add schema")!;
  const ui = created.find((i) => i.title === "Add UI")!;
  ok(api.dependsOn.length === 1 && api.dependsOn[0] === schema.id, "api.dependsOn → schema's REAL id (not the key)");
  ok(ui.dependsOn.includes(api.id) && ui.dependsOn.includes(schema.id), "ui.dependsOn resolved both keys to ids");
  ok(schema.dependsOn.length === 0, "the root item has no dependencies");
}

// ── 2. unknown / self dependencies are dropped (no wedged loop) ──
{
  const store = makeStore({ ...baseMission }, []);
  const created = await createDecomposedItems(store, "m1", [
    { key: "a", title: "A", dependsOn: ["a", "ghost"] }, // self + nonexistent
    { key: "b", title: "B", dependsOn: ["a"] },
  ]);
  const a = created.find((i) => i.title === "A")!;
  const b = created.find((i) => i.title === "B")!;
  ok(a.dependsOn.length === 0, "self-dependency and unknown key dropped");
  ok(b.dependsOn.length === 1 && b.dependsOn[0] === a.id, "valid dependency still resolved");
}

// ── 3. applyDecomposeGuards: cap, unique keys, drop empty titles, strip bad deps ──
{
  const out: DecomposeOutput = {
    items: [
      { key: "dup", title: "First", dependsOn: [] },
      { key: "dup", title: "Second (same key)", dependsOn: ["dup"] }, // collides + self after rename
      { key: "x", title: "   ", dependsOn: [] }, // empty title → dropped
      { key: "y", title: "Keeps", dependsOn: ["nope"] }, // unknown dep → stripped
    ],
  };
  const res = applyDecomposeGuards(out, 7, { maxItems: 10 });
  ok(res.items.length === 3, "empty-title item dropped, the rest kept");
  const keys = res.items.map((i) => i.key);
  ok(new Set(keys).size === keys.length, "keys are made unique (no collisions)");
  ok(res.items.every((i) => (i.dependsOn ?? []).every((k) => keys.includes(k))), "deps to unknown keys stripped");
  ok(res.tokensUsed === 7, "tokens passed through the guards");

  const capped = applyDecomposeGuards(
    { items: Array.from({ length: 50 }, (_, i) => ({ key: `k${i}`, title: `T${i}`, dependsOn: [] })) },
    0,
    { maxItems: 5 },
  );
  ok(capped.items.length === 5, "item count capped at maxItems");
}

// ── 4. runMission decomposes an EMPTY backlog, then works it to done ──
{
  const store = makeStore({ ...baseMission }, []);
  const decomposer = scriptedDecomposer([
    { key: "first", title: "do first", priority: 10, dependsOn: [] },
    { key: "second", title: "do second", priority: 5, dependsOn: ["first"] },
  ]);
  const order: string[] = [];
  const tracking: WorkRunner = {
    async run(it) {
      order.push(it.title);
      return runner.run(it);
    },
  };
  const deps: MissionDeps = { backlog: store, verifier: passingVerifier, runner: tracking, decomposer };
  const out = await runMission(deps, "m1");
  const items = await store.listItems("m1");
  ok(items.length === 2, "decomposer grew the empty backlog from the goal");
  ok(out.status === "done" && out.itemsDone === 2, "both decomposed items ran and verified done");
  ok(order.join(",") === "do first,do second", `dependency order kept (got ${order.join(",")})`);
  ok((await store.getMission("m1"))!.spentTokens === 242, "decompose tokens (42) + work (2×100) folded into budget");
}

// ── 5. idempotent: a NON-empty backlog is never re-decomposed (resume safety) ──
{
  const seeded: BacklogItem = {
    id: "seed-1",
    missionId: "m1",
    title: "hand-seeded item",
    detail: "",
    status: "todo",
    priority: 1,
    dependsOn: [],
    risk: "low",
    runId: null,
    verification: null,
    createdAt: iso(),
    updatedAt: iso(),
  };
  const store = makeStore({ ...baseMission }, [seeded]);
  let called = 0;
  const decomposer: Decomposer = {
    async decompose() {
      called++;
      return { items: [{ key: "x", title: "SHOULD NOT APPEAR" }] };
    },
  };
  const out = await runMission({ backlog: store, verifier: passingVerifier, runner, decomposer }, "m1");
  const titles = (await store.listItems("m1")).map((i) => i.title);
  ok(called === 0, "decomposer NOT called when the backlog already has items");
  ok(titles.length === 1 && titles[0] === "hand-seeded item", "the seeded backlog is untouched");
  ok(out.status === "done", "the pre-seeded mission still completes normally");
}

// ── 6. backward-compat: no decomposer + empty backlog ⇒ mission ends done (nothing to do) ──
{
  const store = makeStore({ ...baseMission }, []);
  const out = await runMission({ backlog: store, verifier: passingVerifier, runner }, "m1");
  ok(out.status === "done" && out.itemsDone === 0, "without a decomposer an empty mission is a no-op, not a crash");
}

console.log("\nM3 Trin 1 decomposer verified ✓");
