/**
 * LIVE proof for the M3 Trin 1 Decomposer — a REAL model turning a goal into a
 * backlog (one LLM call). Unlike verify-decompose.ts (deterministic fakes), this
 * shows the actual plan the model produces and checks it is usable: several
 * concrete items, at least one real dependency, and every key resolvable. Prints
 * the backlog so you can eyeball its quality.
 * Run: pnpm --filter @arzonic/agent-core exec tsx verify-decompose-live.ts
 * Requires a working LLM in .env.
 */
import { loadEnv } from "../shared/src/env.js";
import { getModel } from "../shared/src/llm.js";
import { makeDecomposer } from "./src/nodes/decompose.js";
import type { Mission } from "./src/mission.js";

const ok = (c: boolean, m: string) => {
  if (!c) throw new Error(`FAIL: ${m}`);
  console.log(`  ✓ ${m}`);
};

const env = loadEnv();
const model = getModel(env);
const decomposer = makeDecomposer(model);

const mission: Mission = {
  id: "live1",
  projectId: "p1",
  goal:
    "Build a small REST API for a todo list: list todos, add a todo, mark a todo " +
    "done, and delete a todo. In-memory storage is fine. Include input validation.",
  acceptanceCriteria: ["the four endpoints work", "invalid input is rejected with 4xx"],
  repoPath: "/tmp/repo",
  status: "running",
  budget: null,
  spentTokens: 0,
  deadline: null,
  createdAt: new Date(1_700_000_000_000).toISOString(),
};

console.log(`\nLive decompose: ${env.LLM_PROVIDER}/${env.LLM_MODEL ?? "(default)"}\nGoal: ${mission.goal}\n`);

const plan = await decomposer.decompose({ mission });

console.log("Proposed backlog:");
for (const it of plan.items) {
  const deps = (it.dependsOn ?? []).length ? ` ⟵ ${it.dependsOn!.join(", ")}` : "";
  const risk = it.risk === "high" ? " [HIGH-RISK]" : "";
  console.log(`  • [${it.key}] (p${it.priority ?? 0})${risk} ${it.title}${deps}`);
  if (it.detail) console.log(`      ${it.detail}`);
}
console.log(`\nTokens: ${plan.tokensUsed}${plan.note ? ` | note: ${plan.note}` : ""}\n`);

console.log("Assertions:");
ok(plan.items.length >= 2, `produced a multi-item plan (${plan.items.length} items)`);
ok(plan.items.every((i) => !!i.title?.trim()), "every item has a title");
const keys = new Set(plan.items.map((i) => i.key));
ok(keys.size === plan.items.length, "every item key is unique");
ok(
  plan.items.every((i) => (i.dependsOn ?? []).every((k) => keys.has(k))),
  "every dependsOn references a real key in the plan (resolvable to an id)",
);
ok(
  plan.items.some((i) => (i.dependsOn ?? []).length > 0),
  "the model expressed at least one dependency (it ordered the work)",
);

console.log("\n🎉 M3 Trin 1 LIVE decompose PASSED — the model planned its own backlog from a goal.\n");
