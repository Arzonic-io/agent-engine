/**
 * Proof that every graph node that calls a model tags the call with its role,
 * next to the run's own context — so the usage ledger can say which agent spent
 * what. Each node runs alone in a one-node graph over the real GraphState, with
 * a fake model that goes through LangChain's real call path. Fakes only.
 * Run: pnpm --filter @arzonic/agent-core exec tsx verify-usage-nodes.ts
 */
import { END, START, StateGraph } from "@langchain/langgraph";
import { makeAnalystNode } from "./src/nodes/analyst.js";
import { makeArchitectNode } from "./src/nodes/architect.js";
import { makeBuilderNode } from "./src/nodes/builder.js";
import { makeCriticNode } from "./src/nodes/critic.js";
import { makeImplementerNode } from "./src/nodes/implementer.js";
import { makeLeadNode } from "./src/nodes/lead.js";
import { makeMissionCriticNode } from "./src/nodes/missionCritic.js";
import { makeProposeCriteriaNode } from "./src/nodes/proposeCriteria.js";
import { makeRouterNode } from "./src/nodes/router.js";
import { makeWorkerNode } from "./src/nodes/worker.js";
import { defaultRubric } from "./src/rubric.js";
import { GraphState, type GraphStateType } from "./src/state.js";
import type { RepoTools, WritableRepoTools } from "./src/tools.js";
import { USAGE_METADATA_KEYS as K, usageMetadata, type UsageRole } from "./src/usage.js";
import { MetadataCollector, TextModel, ok, structuredModel } from "./verify-usage-fakes.js";

const TASK = "44444444-4444-4444-8444-444444444444";

/** Every repo method resolves to "" — the fakes never call a tool, and the mission critic's git diff comes back empty. */
const repo = new Proxy(
  {},
  { get: (_target, prop) => (prop === "then" ? undefined : async () => "") },
) as unknown as WritableRepoTools & RepoTools;

type AnyNode = (state: GraphStateType, config?: unknown) => Promise<Partial<GraphStateType>>;

async function rolesFor(node: AnyNode, input: Partial<GraphStateType>): Promise<unknown[]> {
  const graph = new StateGraph(GraphState)
    .addNode("node", node as never)
    .addEdge(START, "node")
    .addEdge("node", END)
    .compile();
  const collector = new MetadataCollector();
  await graph.invoke(
    { task: "Write a haiku", ...input },
    { callbacks: [collector], metadata: usageMetadata({ taskId: TASK }) },
  );
  ok(collector.calls.every((call) => call[K.taskId] === TASK), "the run's task id reaches every call");
  return collector.roles();
}

const verdict = { score: 90, criteria: [], issues: [] };
const step = { title: "Write it", files: [] };
const cases: [UsageRole, AnyNode, Partial<GraphStateType>][] = [
  ["router", makeRouterNode(structuredModel({ topology: "single", reason: "short" })) as AnyNode, {}],
  ["proposeCriteria", makeProposeCriteriaNode(structuredModel({ criteria: [] }), { enabled: true }) as AnyNode, {}],
  ["architect", makeArchitectNode(structuredModel({ plan: [step] }), {}) as AnyNode, {}],
  ["builder", makeBuilderNode(new TextModel({})) as AnyNode, {}],
  ["critic", makeCriticNode(structuredModel(verdict), defaultRubric) as AnyNode, { draft: "a haiku" }],
  ["worker", makeWorkerNode(new TextModel({})) as AnyNode, { plan: [step], currentStep: 0 } as Partial<GraphStateType>],
  ["lead", makeLeadNode(new TextModel({})) as AnyNode, {}],
  ["analyst", makeAnalystNode(new TextModel({}), repo) as AnyNode, {}],
  ["implementer", makeImplementerNode(new TextModel({}), repo) as AnyNode, {}],
  ["missionCritic", makeMissionCriticNode(structuredModel(verdict), repo, defaultRubric) as AnyNode, {}],
  ["missionCritic", makeMissionCriticNode(structuredModel({ pass: true, issues: [] }), repo) as AnyNode, {}],
];

for (const [role, node, input] of cases) {
  const roles = await rolesFor(node, input);
  ok(
    roles.length > 0 && roles.every((r) => r === role),
    `${role}: every call is tagged "${role}" (got ${JSON.stringify(roles)})`,
  );
}

console.log("\nEvery graph node tags its model calls ✓");
