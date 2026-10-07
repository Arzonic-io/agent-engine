/**
 * Proof that the work runner gives every run of an item its own attempt id and
 * tags every model call in the run with mission, item and attempt — the ids the
 * usage ledger groups by. Runs a one-node graph twice for the same item over one
 * MemorySaver, as a retry does. Fakes only.
 * Run: pnpm --filter @arzonic/agent-core exec tsx verify-usage-runner.ts
 */
import { HumanMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { createGraphWorkRunner, type RunnableMissionGraph } from "./src/runner.js";
import { GraphState, type GraphStateType } from "./src/state.js";
import { USAGE_METADATA_KEYS as K, withUsage } from "./src/usage.js";
import { MetadataCollector, TextModel, ok } from "./verify-usage-fakes.js";

const MISSION = "11111111-1111-4111-8111-111111111111";
const ITEM = "22222222-2222-4222-8222-222222222222";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const model = new TextModel({});
const graph = new StateGraph(GraphState)
  .addNode("implementer", async (_state: GraphStateType, config?: RunnableConfig) => {
    await model.invoke([new HumanMessage("build")], withUsage("implementer", { signal: config?.signal }));
    return { draft: "built" };
  })
  .addEdge(START, "implementer")
  .addEdge("implementer", END)
  .compile({ checkpointer: new MemorySaver() });

const collector = new MetadataCollector();
const runner = createGraphWorkRunner(graph as unknown as RunnableMissionGraph, {
  callbacks: [collector],
  usageContext: { missionId: MISSION },
});

const item = { id: ITEM, title: "Add a thing" };
const first = await runner.run(item);
const second = await runner.run(item);

ok(typeof first.attemptId === "string" && UUID.test(first.attemptId), "a run reports a uuid attempt id");
ok(first.attemptId !== second.attemptId, "a retry of the same item gets a new attempt id");
ok(collector.calls.length === 2, `one record per model call (got ${collector.calls.length})`);
ok(
  collector.calls[0]?.[K.attemptId] === first.attemptId && collector.calls[1]?.[K.attemptId] === second.attemptId,
  "each call carries its own run's attempt id",
);
ok(
  collector.calls.every((call) => call[K.itemId] === ITEM && call[K.missionId] === MISSION),
  "every call carries the item and the runner's mission",
);
ok(collector.calls.every((call) => call[K.role] === "implementer"), "the node's role survives next to the runner's context");

console.log("\nThe runner attributes every run ✓");
