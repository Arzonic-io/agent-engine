/**
 * Proof that usage attribution survives LangChain's run tree: metadata set on the
 * OUTERMOST invoke (mission, item, attempt) reaches every nested model call, a
 * node's own role tag never erases it, and a role set at a component boundary
 * outlives the inner graph createReactAgent builds. Fakes only — no key, no DB.
 * Run: pnpm --filter @arzonic/agent-core exec tsx verify-usage-context.ts
 */
import { HumanMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { USAGE_METADATA_KEYS as K, usageMetadata, withUsage } from "./src/usage.js";
import { MetadataCollector, TextModel, ok } from "./verify-usage-fakes.js";

const MISSION = "11111111-1111-4111-8111-111111111111";
const ITEM = "22222222-2222-4222-8222-222222222222";
const ATTEMPT = "33333333-3333-4333-8333-333333333333";

// ── 1. The pure helpers ──
const meta = usageMetadata({ missionId: MISSION, attemptId: ATTEMPT });
ok(meta[K.missionId] === MISSION && meta[K.attemptId] === ATTEMPT, "usageMetadata maps the known ids");
ok(!(K.itemId in meta) && !(K.taskId in meta), "usageMetadata leaves unknown ids out");

const signal = new AbortController().signal;
const tagged = withUsage("critic", { signal, recursionLimit: 7, metadata: { keep: "me" } }, { itemId: ITEM });
ok(tagged.signal === signal && tagged.recursionLimit === 7, "withUsage keeps the caller's signal and recursionLimit");
ok(tagged.metadata?.keep === "me", "withUsage keeps the caller's own metadata");
ok(tagged.metadata?.[K.role] === "critic" && tagged.metadata?.[K.itemId] === ITEM, "withUsage adds the role and the context");

// ── 2. Through a graph: the outer context plus each node's own role tag ──
const State = Annotation.Root({
  note: Annotation<string>({ reducer: (_a, b) => b, default: () => "" }),
});
const model = new TextModel({});
const agent = createReactAgent({ llm: new TextModel({}), tools: [] });

const graph = new StateGraph(State)
  .addNode("review", async (_state, config?: RunnableConfig) => {
    await model.invoke([new HumanMessage("review")], withUsage("critic", { signal: config?.signal }));
    return { note: "reviewed" };
  })
  .addNode("implement", async (_state, config?: RunnableConfig) => {
    await agent.invoke(
      { messages: [new HumanMessage("build")] },
      withUsage("implementer", { recursionLimit: 10, signal: config?.signal }),
    );
    return { note: "built" };
  })
  .addEdge(START, "review")
  .addEdge("review", "implement")
  .addEdge("implement", END)
  .compile();

const collector = new MetadataCollector();
await graph.invoke(
  {},
  {
    callbacks: [collector],
    metadata: usageMetadata({ missionId: MISSION, itemId: ITEM, attemptId: ATTEMPT }),
  },
);

ok(collector.calls.length === 2, `one record per model call (got ${collector.calls.length})`);
ok(collector.calls[0]?.[K.role] === "critic", "a node's call carries the node's role");
ok(
  collector.calls[1]?.[K.role] === "implementer",
  "a call inside createReactAgent keeps the component's role, not the inner node's name",
);
for (const call of collector.calls) {
  ok(
    call[K.missionId] === MISSION && call[K.itemId] === ITEM && call[K.attemptId] === ATTEMPT,
    `the outer run's mission, item and attempt reach the ${String(call[K.role])} call`,
  );
}

// ── 3. A top-level call outside any graph carries its own callbacks and context ──
const solo = new MetadataCollector();
await model.invoke(
  [new HumanMessage("decide")],
  withUsage("replan", { callbacks: [solo] }, { missionId: MISSION, itemId: ITEM, attemptId: ATTEMPT }),
);
ok(
  solo.calls.length === 1 && solo.calls[0]?.[K.role] === "replan" && solo.calls[0]?.[K.itemId] === ITEM,
  "a standalone call is tagged from its own config",
);

console.log("\nUsage context survives the run tree ✓");
