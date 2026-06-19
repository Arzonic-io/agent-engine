/**
 * Throwaway proof of the async parked-item resume fix: approving a parked item
 * on a mission the controller parked (status "blocked") must flip the mission
 * back to "running" so the PM2 worker — which scans only "running" missions —
 * re-picks it. Without this the approved work is re-queued but never resumes,
 * breaking the "never block the loop" invariant. Pure — no LLM, no DB (a tiny
 * in-memory store stands in for BacklogStore).
 * Run: pnpm --filter @arzonic/agent-core exec tsx verify-resume-mission.ts
 */
import {
  approveParkedItem,
  rejectParkedItem,
  resumeMissionIfBlocked,
} from "./src/humanPolicy.js";
import type {
  BacklogItem,
  BacklogStore,
  Mission,
  MissionStatus,
} from "./src/mission.js";

const ok = (c: boolean, m: string) => {
  if (!c) throw new Error(`FAIL: ${m}`);
  console.log(`ok: ${m}`);
};

// ── tiny in-memory store holding ONE mission + its items ──
function makeStore(mission: Mission, items: BacklogItem[] = []): BacklogStore {
  const m = { ...mission };
  const map = new Map(items.map((i) => [i.id, { ...i }]));
  const unused = () => {
    throw new Error("unused");
  };
  return {
    createMission: unused,
    async getMission(id) {
      return id === m.id ? { ...m } : null;
    },
    listMissions: unused,
    async updateMission(id, patch) {
      if (id !== m.id) return null;
      Object.assign(m, patch);
      return { ...m };
    },
    deleteMission: unused,
    createItem: unused,
    async getItem(id) {
      const i = map.get(id);
      return i ? { ...i } : null;
    },
    async listItems() {
      return [...map.values()];
    },
    async updateItem(id, patch) {
      const i = map.get(id);
      if (!i) return null;
      Object.assign(i, patch);
      return { ...i };
    },
    nextActionable: unused,
  };
}

function mission(over: Partial<Mission> = {}): Mission {
  return {
    id: "m1",
    projectId: "p1",
    goal: "Ship it",
    acceptanceCriteria: [],
    repoPath: "/r",
    status: "blocked",
    budget: null,
    spentTokens: 0,
    deadline: null,
    createdAt: "t",
    ...over,
  };
}

function item(id: string, over: Partial<BacklogItem> = {}): BacklogItem {
  return {
    id,
    missionId: "m1",
    title: id,
    detail: "",
    status: "todo",
    priority: 0,
    dependsOn: [],
    risk: "low",
    runId: null,
    verification: null,
    createdAt: "t",
    updatedAt: "t",
    ...over,
  };
}

/** Mirrors MissionsService.decideItem's decision path (approve also resumes). */
async function decide(
  store: BacklogStore,
  itemId: string,
  missionId: string,
  decision: "approve" | "reject",
): Promise<BacklogItem | null> {
  if (decision === "approve") {
    const updated = await approveParkedItem(store, itemId);
    await resumeMissionIfBlocked(store, missionId);
    return updated;
  }
  return rejectParkedItem(store, itemId);
}

// ── resumeMissionIfBlocked: ONLY blocked is resurrected ──
{
  const store = makeStore(mission({ status: "blocked" }));
  const out = await resumeMissionIfBlocked(store, "m1");
  ok(out?.status === "running", "blocked ⇒ flipped to running");
  ok((await store.getMission("m1"))?.status === "running", "running change is persisted");
}

for (const status of ["running", "paused", "stopped", "done", "failed"] as MissionStatus[]) {
  const store = makeStore(mission({ status }));
  const out = await resumeMissionIfBlocked(store, "m1");
  ok(out?.status === status, `${status} is left untouched (only blocked resurrects)`);
}

{
  // A human deliberately stopped the mission — approving a stray parked item must
  // NOT secretly restart it. This is the dangerous case the guard protects.
  const store = makeStore(mission({ status: "stopped" }));
  await resumeMissionIfBlocked(store, "m1");
  ok((await store.getMission("m1"))?.status === "stopped", "a human-stopped mission stays stopped");
}

{
  const store = makeStore(mission({ status: "blocked" }));
  const out = await resumeMissionIfBlocked(store, "does-not-exist");
  ok(out === null, "a missing mission resolves to null (no throw)");
  ok((await store.getMission("m1"))?.status === "blocked", "the real mission is untouched");
}

// ── decideItem behaviour: approve from blocked resumes; reject never does ──
{
  const store = makeStore(mission({ status: "blocked" }), [
    item("p", { status: "blocked_needs_human", risk: "high" }),
  ]);
  const updated = await decide(store, "p", "m1", "approve");
  ok(updated?.status === "todo" && updated?.risk === "low", "approve re-queues the parked item (todo/low)");
  ok((await store.getMission("m1"))?.status === "running", "approve from a blocked mission flips it back to running");
}

{
  const store = makeStore(mission({ status: "running" }), [
    item("p", { status: "blocked_needs_human", risk: "high" }),
  ]);
  await decide(store, "p", "m1", "approve");
  ok((await store.getMission("m1"))?.status === "running", "approve while running is a no-op on mission status");
}

{
  const store = makeStore(mission({ status: "blocked" }), [
    item("p", { status: "blocked_needs_human", risk: "high" }),
  ]);
  const updated = await decide(store, "p", "m1", "reject");
  ok(updated?.status === "failed", "reject marks the parked item failed");
  ok((await store.getMission("m1"))?.status === "blocked", "reject never re-activates the mission (stays blocked)");
}

console.log("\nResume-mission fix verified ✓");
