/**
 * Proof that the components the controller calls OUTSIDE a graph run — survey,
 * decomposer, replanner, rubric assessor and test author — carry the runtime's
 * callbacks and tag every model call with their role and the mission, item and
 * attempt they read off their own input. Fakes only.
 * Run: pnpm --filter @arzonic/agent-core exec tsx verify-usage-components.ts
 */
import type { BacklogItem, Mission } from "./src/mission.js";
import { makeDecomposer } from "./src/nodes/decompose.js";
import { makeReplanner } from "./src/nodes/replan.js";
import { surveyRepo } from "./src/nodes/repoSurvey.js";
import { makeRubricAssessor } from "./src/nodes/rubricAssessor.js";
import { makeTestAuthor } from "./src/nodes/testAuthor.js";
import { defaultRubric } from "./src/rubric.js";
import type { WorkResult } from "./src/runner.js";
import type { RepoTools, WritableRepoTools } from "./src/tools.js";
import { USAGE_METADATA_KEYS as K } from "./src/usage.js";
import { MetadataCollector, TextModel, ok, structuredModel } from "./verify-usage-fakes.js";

const MISSION = "11111111-1111-4111-8111-111111111111";
const ITEM = "22222222-2222-4222-8222-222222222222";
const ATTEMPT = "33333333-3333-4333-8333-333333333333";

const repo = new Proxy(
  {},
  { get: (_target, prop) => (prop === "then" ? undefined : async () => "") },
) as unknown as WritableRepoTools & RepoTools;

const mission = {
  id: MISSION,
  projectId: "55555555-5555-4555-8555-555555555555",
  goal: "Ship the thing",
  acceptanceCriteria: [],
  checks: ["test"],
  repoPath: "/tmp/usage-verify",
  status: "running",
  budget: null,
  spentTokens: 0,
  deadline: null,
  roleModels: {},
  guidance: null,
  iterations: 0,
  noProgress: 0,
  stopReason: null,
  createdAt: new Date().toISOString(),
} as unknown as Mission;
const item = {
  id: ITEM,
  missionId: MISSION,
  title: "Add the thing",
  detail: "",
  status: "in_progress",
  priority: 0,
  dependsOn: [],
  risk: "low",
  verify: "",
} as unknown as BacklogItem;
const result: WorkResult = {
  runId: ITEM,
  attemptId: ATTEMPT,
  status: "accepted",
  draft: "done",
  verdict: null,
  tokensUsed: 0,
  worktree: "/tmp/usage-verify",
} as WorkResult;

function expectTagged(collector: MetadataCollector, roles: string[], withItem: boolean): void {
  ok(
    JSON.stringify(collector.roles()) === JSON.stringify(roles),
    `calls are tagged ${JSON.stringify(roles)} (got ${JSON.stringify(collector.roles())})`,
  );
  for (const call of collector.calls) {
    ok(call[K.missionId] === MISSION, `${String(call[K.role])}: carries the mission`);
    if (withItem) {
      ok(call[K.itemId] === ITEM && call[K.attemptId] === ATTEMPT, `${String(call[K.role])}: carries the item and the attempt`);
    }
  }
}

// Survey run by the runtime, outside any graph.
{
  const c = new MetadataCollector();
  await surveyRepo({ model: new TextModel({}), repo, brief: "Ship it", callbacks: [c], usageContext: { missionId: MISSION } });
  expectTagged(c, ["survey"], false);
}

// Decomposer with a survey supplied by the runtime: one call.
{
  const c = new MetadataCollector();
  const decomposer = makeDecomposer(
    structuredModel({ items: [{ key: "a", title: "Add it", files: [], dependsOn: [] }], reasoning: "scripted" }),
    { allowedChecks: ["test"], survey: "a known layout", callbacks: [c] },
  );
  await decomposer.decompose({ mission });
  expectTagged(c, ["decompose"], false);
}

// Decomposer that surveys by itself: the survey loop and the plan, both on the mission.
{
  const c = new MetadataCollector();
  const decomposer = makeDecomposer(
    structuredModel({ items: [{ key: "a", title: "Add it", files: [], dependsOn: [] }], reasoning: "scripted" }),
    { allowedChecks: ["test"], repo, callbacks: [c] },
  );
  await decomposer.decompose({ mission });
  expectTagged(c, ["survey", "decompose"], false);
}

// Replanner: mission, item and attempt from its input.
{
  const c = new MetadataCollector();
  const replanner = makeReplanner(
    structuredModel({ itemStatus: "done", reasoning: "green", followUps: [] }),
    { callbacks: [c] },
  );
  await replanner.replan({ mission, item, result, verification: { passed: true, results: [] } });
  expectTagged(c, ["replan"], true);
}

// Rubric assessor.
{
  const c = new MetadataCollector();
  const assessor = makeRubricAssessor(
    structuredModel({ score: 90, note: "fine", criteria: [] }),
    { evidence: async () => "diff --git a/x b/x", callbacks: [c] },
  );
  await assessor.assess({ mission, rubric: defaultRubric, doneCount: 1 });
  expectTagged(c, ["rubricAssessor"], false);
}

// Test author: its tool loop, on the item's attempt.
{
  const c = new MetadataCollector();
  const author = makeTestAuthor(new TextModel({}), { repo: () => repo, callbacks: [c] });
  await author.authorTest({ mission, item, result });
  expectTagged(c, ["tester"], true);
}

console.log("\nComponents outside a graph are attributed ✓");
