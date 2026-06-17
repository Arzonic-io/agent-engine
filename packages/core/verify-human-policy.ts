/**
 * Throwaway proof of the human-policy logic (build-order Trin 7): risk
 * classification, the digest rollup, and approve/reject of parked items. Pure —
 * no LLM, no DB (a tiny in-memory store stands in for BacklogStore).
 * Run: pnpm --filter @arzonic/agent-core exec tsx verify-human-policy.ts
 */
import {
  approveParkedItem,
  buildDigest,
  classifyRisk,
  rejectParkedItem,
} from "./src/humanPolicy.js";
import type { BacklogItem, BacklogStore, Mission } from "./src/mission.js";

const ok = (c: boolean, m: string) => {
  if (!c) throw new Error(`FAIL: ${m}`);
  console.log(`ok: ${m}`);
};

// ── risk classification ──
ok(classifyRisk({ title: "Deploy to production" }) === "high", "deploy ⇒ high");
ok(classifyRisk({ title: "Drop table users" }) === "high", "data deletion ⇒ high");
ok(classifyRisk({ title: "Add Stripe payment flow" }) === "high", "payment ⇒ high");
ok(classifyRisk({ title: "Rotate the API key" }) === "high", "secrets ⇒ high");
ok(classifyRisk({ title: "Add a health endpoint" }) === "low", "ordinary work ⇒ low");
ok(
  classifyRisk({ title: "Tidy the readme", risk: "high" }) === "high",
  "planner's explicit high flag always wins",
);
ok(
  classifyRisk({ title: "Wipe the cache" }, ["wipe"]) === "high",
  "host extra pattern (MISSION_HIGH_RISK_PATTERNS) is honoured",
);

// ── tiny in-memory store for approve/reject ──
function makeStore(items: BacklogItem[]): BacklogStore {
  const map = new Map(items.map((i) => [i.id, { ...i }]));
  const unused = () => {
    throw new Error("unused");
  };
  return {
    createMission: unused,
    getMission: unused,
    listMissions: unused,
    updateMission: unused,
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

// ── approve clears risk + re-queues; reject fails ──
{
  const store = makeStore([item("p", { status: "blocked_needs_human", risk: "high" })]);
  const approved = await approveParkedItem(store, "p");
  ok(approved?.status === "todo", "approve re-queues the parked item (todo)");
  ok(approved?.risk === "low", "approve clears the high-risk flag so the loop won't re-park it");

  const store2 = makeStore([item("q", { status: "blocked_needs_human", risk: "high" })]);
  const rejected = await rejectParkedItem(store2, "q");
  ok(rejected?.status === "failed", "reject marks the parked item failed");
}

// ── digest rollup ──
{
  const mission: Mission = {
    id: "m1",
    projectId: "p1",
    goal: "Ship it",
    acceptanceCriteria: [],
    repoPath: "/r",
    status: "blocked",
    budget: null,
    spentTokens: 4200,
    deadline: null,
    createdAt: "t",
  };
  const items: BacklogItem[] = [
    item("a", { title: "done A", status: "done" }),
    item("b", { title: "parked B", status: "blocked_needs_human" }),
    item("c", { title: "failed C", status: "failed" }),
    item("d", { title: "next D", status: "todo", priority: 5 }),
    item("e", { title: "blocked E", status: "todo", dependsOn: ["z"] }), // dep not done
  ];
  const d = buildDigest(mission, items);
  ok(d.done.join() === "done A", "digest lists done titles");
  ok(d.parked.join() === "parked B", "digest lists parked titles");
  ok(d.failed.join() === "failed C", "digest lists failed titles");
  ok(d.next.join() === "next D", "digest 'next' = actionable todo (deps satisfied), excludes blocked-on-deps");
  ok(d.pending === 2, "digest counts both todo items as pending");
  ok(d.spentTokens === 4200 && d.status === "blocked", "digest carries spend + status");
}

console.log("\nHuman-policy logic verified ✓");
