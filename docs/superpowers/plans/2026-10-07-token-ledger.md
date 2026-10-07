# Token-ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every model call in agent-engine becomes one row in a Postgres ledger (`llm_usage`) with mission, item, attempt, role, model, raw token classes, budget-weighted tokens and estimated price — shown per role, per item and per finished item in a "Forbrug pr. rolle" panel on the mission page.

**Architecture:** Core tags LangChain runs with metadata (`ae_role`, `ae_mission_id`, `ae_item_id`, `ae_attempt_id`, `ae_task_id`) via a pure helper, `withUsage`. The runtime attaches ONE inheritable callback handler (shared's usage recorder) at each top-level invoke. LangChain's callback managers carry the outer metadata down to every nested model call, including every turn inside `createReactAgent`. The recorder buffers rows in memory and flushes them idempotently to `llm_usage`. The API summarises them for the panel.

**Tech Stack:** TypeScript (ES2022, ESM), @langchain/core 1.1.49, @langchain/langgraph 1.4.2, pg, NestJS (api), Next.js + Tailwind/daisyUI (web), tsx for verify scripts, pnpm + turbo.

**Spec:** `docs/superpowers/specs/2026-10-07-token-ledger-design.md`

## Global Constraints

- `packages/core/src` stays pure TypeScript: no I/O and no `node:` imports. Use `globalThis.crypto.randomUUID()`, not `node:crypto`.
- The budget is unchanged. Do not edit any `billableTokens(...)` call site, `controller.ts`, or the budget watcher.
- Measuring must never break a model call, the API boot or the worker boot. Failures are logged, never thrown into the caller.
- Unknown is `null`, never `0`: missing usage, an unknown price and lost calls stay visible.
- Callbacks go on the OUTERMOST invoke as inheritable handlers — never as constructor callbacks on a model (metadata does not propagate then).
- Do not upgrade any LangChain package.
- Only verified prices go in the price table (`PRICE_TABLE_VERSION = "2026-10-07"`). A missing model is a one-line addition, never a guess.
- Repo conventions: commit directly on `main`, commit after every task, never push. Commit messages are English with a conventional prefix and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- UI copy is Danish. Code, comments and identifiers are English.
- Core is consumed through `dist`. After changing `packages/core/src`, run `pnpm --filter @arzonic/agent-core build` before running anything in `packages/shared` or `apps/*`. Root `pnpm typecheck` builds dependencies first.

## File Structure

| File | Responsibility |
|---|---|
| `packages/core/src/usage.ts` (new) | Role names, metadata keys, `usageMetadata`, `withUsage`. Pure. |
| `packages/core/src/index.ts` | Export the usage helpers. |
| `packages/core/src/runner.ts` | Per-run `attemptId`, `callbacks` and `usageContext` on every graph run; `WorkResult.attemptId`. |
| `packages/core/src/nodes/*.ts` (15 files) | Each model call site tags its role. Components outside a graph accept `callbacks` and derive their context from their input. |
| `packages/core/verify-usage-fakes.ts` (new) | Shared fakes for the usage verify scripts (not a verify script). |
| `packages/core/verify-usage-{context,runner,nodes,components}.ts` (new) | Proofs for tasks 1–4. |
| `packages/shared/src/pricing.ts` (new) | Dated price table; `priceFor`, `estimateCostUsd`. |
| `packages/shared/src/usageRecorder.ts` (new) | The callback handler, row building and the buffered, idempotent writer. |
| `packages/shared/src/usageLedger.ts` (new) | `UsageLedgerService`: the `llm_usage` schema, `insert`, `missionSummary` and `taskSummary`. |
| `packages/shared/src/index.ts` | Exports. |
| `packages/shared/verify-{pricing,usage-recorder,usage-ledger}.ts` (new) | Proofs for tasks 5–7. |
| `apps/api/src/usage.provider.ts` (new) | `createUsage(env)` → `{ ledger, recorder } \| null`. |
| `apps/api/src/{tokens,app.module}.ts` | `USAGE` provider (after `BACKLOG`). |
| `apps/api/src/runs/runs.{service,controller}.ts` | Callbacks + `ae_task_id` on every run; `GET /runs/:id/usage`. |
| `apps/api/src/missions/missions.{service,controller}.ts` | `GET /missions/:id/usage`. |
| `apps/api/src/mission-worker.ts` | One recorder; callbacks and mission context to every component; flush on shutdown. |
| `packages/client/src/types.ts` | `ApiUsageSummary` and parts. |
| `apps/web/app/api/missions/[id]/usage/route.ts` (new) | Proxy to the API. |
| `apps/web/app/components/MissionUsagePanel.tsx` (new) | The "Forbrug pr. rolle" panel. |
| `apps/web/app/missions/[id]/page.tsx` | Render the panel. |

---

### Task 1: Usage context in core

**Files:**
- Create: `packages/core/src/usage.ts`
- Modify: `packages/core/src/index.ts` (add an export block)
- Create: `packages/core/verify-usage-fakes.ts`
- Test: `packages/core/verify-usage-context.ts`

**Interfaces:**
- Produces: `USAGE_ROLES`, `type UsageRole`, `USAGE_METADATA_KEYS` (`role: "ae_role"`, `missionId: "ae_mission_id"`, `itemId: "ae_item_id"`, `attemptId: "ae_attempt_id"`, `taskId: "ae_task_id"`), `interface UsageContext { missionId?; itemId?; attemptId?; taskId? }`, `usageMetadata(ctx: UsageContext): Record<string, string>`, `withUsage(role: UsageRole, config?: RunnableConfig, ctx?: UsageContext): RunnableConfig`.
- Produces (test helpers): `ok`, `FAKE_USAGE`, `MetadataCollector` (records the metadata of every chat-model call; `.calls`, `.roles()`), `TextModel` (tool-capable, plain answer), `structuredModel(args)` (real structured-output pipeline, always answers `args`; `bindTools` returns a `TextModel`).

- [ ] **Step 1: Write the shared test fakes**

Create `packages/core/verify-usage-fakes.ts`:

```ts
/**
 * Shared fakes for the verify-usage-*.ts scripts — not a verify script itself.
 * Every fake goes through LangChain's real BaseChatModel call path, so callback
 * handlers fire exactly as they do for a real provider.
 */
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  assembleStructuredOutputPipeline,
  createFunctionCallingParser,
} from "@langchain/core/language_models/structured_output";
import type { Serialized } from "@langchain/core/load/serializable";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";

export const ok = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`ok: ${message}`);
};

export const FAKE_USAGE = { input_tokens: 10, output_tokens: 5, total_tokens: 15 };

/** Records the metadata LangChain hands every chat-model call. */
export class MetadataCollector extends BaseCallbackHandler {
  name = "metadata_collector";
  readonly calls: Record<string, unknown>[] = [];

  constructor() {
    super({ _awaitHandler: true });
  }

  override handleChatModelStart(
    _llm: Serialized,
    _messages: BaseMessage[][],
    _runId: string,
    _parentRunId?: string,
    _extraParams?: Record<string, unknown>,
    _tags?: string[],
    metadata?: Record<string, unknown>,
  ): void {
    this.calls.push({ ...(metadata ?? {}) });
  }

  /** The role of every call seen, in call order. */
  roles(): unknown[] {
    return this.calls.map((call) => call.ae_role);
  }
}

/** A tool-capable chat model that answers in plain text and never calls a tool. */
export class TextModel extends BaseChatModel {
  _llmType(): string {
    return "fake-text";
  }

  override bindTools() {
    return this;
  }

  async _generate(): Promise<ChatResult> {
    const message = new AIMessage({ content: "done", usage_metadata: FAKE_USAGE });
    return { generations: [{ text: "done", message }] };
  }
}

/**
 * A chat model whose structured-output calls go through LangChain's real
 * function-calling pipeline and always answer `args` under the requested tool
 * name. Its tool-calling side (a ReAct loop, e.g. a survey) is a TextModel.
 */
export function structuredModel(args: Record<string, unknown>): BaseChatModel {
  let toolName = "tool";
  class Scripted extends BaseChatModel {
    _llmType(): string {
      return "fake-structured";
    }

    override bindTools() {
      return new TextModel({});
    }

    async _generate(): Promise<ChatResult> {
      const message = new AIMessage({
        content: "",
        tool_calls: [{ id: "call-1", name: toolName, args }],
        usage_metadata: FAKE_USAGE,
      });
      return { generations: [{ text: "", message }] };
    }
  }
  const model = new Scripted({});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (model as any).withStructuredOutput = (schema: any, config?: { name?: string; includeRaw?: boolean }) => {
    toolName = config?.name ?? toolName;
    return assembleStructuredOutputPipeline(
      model,
      createFunctionCallingParser(schema, toolName),
      config?.includeRaw,
    );
  };
  return model;
}
```

- [ ] **Step 2: Write the failing test**

Create `packages/core/verify-usage-context.ts`:

```ts
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @arzonic/agent-core exec tsx verify-usage-context.ts`
Expected: FAIL with `Cannot find module './src/usage.js'` (or `ERR_MODULE_NOT_FOUND`).

- [ ] **Step 4: Write the implementation**

Create `packages/core/src/usage.ts`:

```ts
/**
 * Usage attribution: which mission, item, attempt and agent role a model call
 * belongs to. Pure data — core never stores usage. It only tags LangChain runs
 * with metadata. The runtime attaches a callback handler (shared's usage
 * recorder) at the OUTERMOST invoke, and that handler reads these keys off every
 * model call beneath it.
 *
 * Why metadata and not node-local bookkeeping: LangChain's callback managers
 * carry inheritable metadata from the outermost run down to every nested model
 * call — each turn inside a ReAct loop included, and calls in a loop that later
 * throws. Tagging once at each boundary therefore attributes every call beneath
 * it without threading a meter through every node. That only holds when the
 * handler is inheritable (passed at the top-level invoke), never when it sits on
 * a model as a constructor callback.
 */
import type { RunnableConfig } from "@langchain/core/runnables";

/** Every place a model is called from — one role per call-site family. */
export const USAGE_ROLES = [
  "router",
  "architect",
  "proposeCriteria",
  "builder",
  "critic",
  "worker",
  "lead",
  "analyst",
  "survey",
  "decompose",
  "implementer",
  "missionCritic",
  "tester",
  "replan",
  "rubricAssessor",
] as const;
export type UsageRole = (typeof USAGE_ROLES)[number];

/** The metadata keys the usage recorder reads. Prefixed so they never collide with LangChain's own. */
export const USAGE_METADATA_KEYS = {
  role: "ae_role",
  missionId: "ae_mission_id",
  itemId: "ae_item_id",
  attemptId: "ae_attempt_id",
  taskId: "ae_task_id",
} as const;

/** What a call belongs to. Every field is optional — a run sets what it knows. */
export interface UsageContext {
  missionId?: string;
  itemId?: string;
  /** One id per run of an item, so a retry's spend is told apart from the attempt before it. */
  attemptId?: string;
  /** An interactive run: the tasks.id, or the ad-hoc run id of a run without a project. */
  taskId?: string;
}

/** The context as LangChain metadata, leaving out what isn't known. */
export function usageMetadata(context: UsageContext): Record<string, string> {
  const out: Record<string, string> = {};
  if (context.missionId) out[USAGE_METADATA_KEYS.missionId] = context.missionId;
  if (context.itemId) out[USAGE_METADATA_KEYS.itemId] = context.itemId;
  if (context.attemptId) out[USAGE_METADATA_KEYS.attemptId] = context.attemptId;
  if (context.taskId) out[USAGE_METADATA_KEYS.taskId] = context.taskId;
  return out;
}

/**
 * A call config tagged with `role` (and optionally a context), keeping every key
 * the caller already set — `signal`, `recursionLimit`, `callbacks` and its own
 * metadata. Pass the result as the invoke config at a model call site.
 */
export function withUsage(
  role: UsageRole,
  config: RunnableConfig = {},
  context: UsageContext = {},
): RunnableConfig {
  return {
    ...config,
    metadata: {
      ...config.metadata,
      ...usageMetadata(context),
      [USAGE_METADATA_KEYS.role]: role,
    },
  };
}
```

In `packages/core/src/index.ts`, directly below the line `export { billableTokens, type UsageMetadataLike } from "./tokens.js";`, add:

```ts
export {
  USAGE_ROLES,
  USAGE_METADATA_KEYS,
  usageMetadata,
  withUsage,
  type UsageRole,
  type UsageContext,
} from "./usage.js";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @arzonic/agent-core exec tsx verify-usage-context.ts`
Expected: every line prints `ok: …`, and the last line is `Usage context survives the run tree ✓`.

If check 2 fails (the outer mission/item/attempt is missing on a nested call), STOP and report it. The whole design depends on inheritable metadata, so do not work around it locally.

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @arzonic/agent-core typecheck`
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/usage.ts packages/core/src/index.ts packages/core/verify-usage-fakes.ts packages/core/verify-usage-context.ts
git commit -m "$(cat <<'EOF'
feat(usage): tag model calls with their role and the run they belong to

withUsage() marks a call site's role on its invoke config without dropping
the caller's signal, recursionLimit or metadata; usageMetadata() turns a
mission/item/attempt/task context into LangChain metadata. Pure — core
stores nothing; a callback at the outermost invoke reads the keys off
every nested model call, including each turn inside createReactAgent.

Verified: verify-usage-context.ts drives a real StateGraph and a real
createReactAgent with fakes and shows the outer context reaching every
call next to each node's own role.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: The runner gives every run an attempt id and its context

**Files:**
- Modify: `packages/core/src/runner.ts` (imports, `WorkResult`, `GraphWorkRunnerOptions`, `createGraphWorkRunner().run`)
- Test: `packages/core/verify-usage-runner.ts`

**Interfaces:**
- Consumes: `usageMetadata`, `UsageContext`, `withUsage` (Task 1); `MetadataCollector`, `TextModel`, `ok` (Task 1 fakes).
- Produces: `WorkResult.attemptId?: string`; `GraphWorkRunnerOptions.callbacks?: Callbacks`; `GraphWorkRunnerOptions.usageContext?: UsageContext`. `createWorktreeWorkRunner` passes both through unchanged, because it spreads the remaining options into `createGraphWorkRunner`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/verify-usage-runner.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @arzonic/agent-core exec tsx verify-usage-runner.ts`
Expected: FAIL with `FAIL: a run reports a uuid attempt id`.

- [ ] **Step 3: Write the implementation**

In `packages/core/src/runner.ts`:

1. Add these imports below the existing import block:

```ts
import type { Callbacks } from "@langchain/core/callbacks/manager";
import { usageMetadata, type UsageContext } from "./usage.js";
```

2. In `interface WorkResult`, directly after the `tokensUsed: number;` field and its doc comment, add:

```ts
  /**
   * One id per run of an item. Every model call in the run is tagged with it, so
   * a usage ledger can tell a retry's spend from the attempt before it. The
   * thread stays the item id (the dashboard reads it); only attribution is per run.
   */
  attemptId?: string;
```

3. In `interface GraphWorkRunnerOptions`, add as the last two fields:

```ts
  /**
   * Callback handlers attached to every graph run — e.g. the usage recorder.
   * Inheritable: they see every model call beneath the run, including each turn
   * inside the implementer's tool loop.
   */
  callbacks?: Callbacks;
  /** Attribution added to every run's metadata (e.g. `{ missionId }`). The runner adds the item and the attempt itself. */
  usageContext?: UsageContext;
```

4. In `createGraphWorkRunner`, replace

```ts
      const config = { configurable: { thread_id: item.id }, signal };
```

with

```ts
      const attemptId = globalThis.crypto.randomUUID();
      const config = {
        configurable: { thread_id: item.id },
        signal,
        callbacks: options.callbacks,
        metadata: usageMetadata({ ...options.usageContext, itemId: item.id, attemptId }),
      };
```

5. In the same function's `return { … }`, add `attemptId,` directly after `runId: item.id,`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @arzonic/agent-core exec tsx verify-usage-runner.ts`
Expected: all `ok: …`, ending with `The runner attributes every run ✓`.

Run the retry and runner proofs that already exist, to show nothing regressed:
`pnpm --filter @arzonic/agent-core exec tsx verify-item-retry.ts && pnpm --filter @arzonic/agent-core exec tsx verify-runner.ts && pnpm --filter @arzonic/agent-core exec tsx verify-worktree-runner.ts`
Expected: each ends with its `✓` line.

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm --filter @arzonic/agent-core typecheck`
Expected: exits 0.

```bash
git add packages/core/src/runner.ts packages/core/verify-usage-runner.ts
git commit -m "$(cat <<'EOF'
feat(usage): every run of an item carries its own attempt id

The runner mints an attempt id per run and puts mission, item and
attempt on the run's metadata next to the runtime's callbacks, so every
model call in an item's run is attributable — and a retry's spend is
told apart from the attempt before it. WorkResult.attemptId hands the id
to the replanner and test author, which run outside the graph. The
thread stays the item id; nothing about checkpointing changes.

Verified: verify-usage-runner.ts (two runs of one item over one
MemorySaver); verify-item-retry, verify-runner and verify-worktree-runner
still pass.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Every graph node tags its model calls

**Files:**
- Modify: `packages/core/src/nodes/router.ts`, `proposeCriteria.ts`, `architect.ts`, `builder.ts`, `critic.ts`, `worker.ts`, `lead.ts`, `analyst.ts`, `implementer.ts`, `missionCritic.ts`
- Test: `packages/core/verify-usage-nodes.ts`

**Interfaces:**
- Consumes: `withUsage`, `usageMetadata`, `USAGE_METADATA_KEYS`, `UsageRole` (Task 1); `MetadataCollector`, `TextModel`, `structuredModel`, `ok` (Task 1 fakes).
- Produces: no new exports. Every listed node now passes `withUsage("<role>", …)` as its model invoke config.

- [ ] **Step 1: Write the failing test**

Create `packages/core/verify-usage-nodes.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @arzonic/agent-core exec tsx verify-usage-nodes.ts`
Expected: FAIL on the first case with `FAIL: router: every call is tagged "router" (got [null])`. The value may print as `[undefined]` instead; either way the role is missing.

- [ ] **Step 3: Tag the role at each call site**

In each file below, add this import directly under the existing `import { billableTokens } from "../tokens.js";` line:

```ts
import { withUsage } from "../usage.js";
```

Then make these replacements.

`router.ts` — replace

```ts
    const { raw, parsed } = await structured.invoke([
      new SystemMessage(SYSTEM_PROMPT),
      new HumanMessage(`Task:\n${state.task}`),
    ]);
```

with

```ts
    const { raw, parsed } = await structured.invoke(
      [new SystemMessage(SYSTEM_PROMPT), new HumanMessage(`Task:\n${state.task}`)],
      withUsage("router"),
    );
```

`proposeCriteria.ts` — replace

```ts
    const { raw, parsed } = await structured.invoke([
      new SystemMessage(SYSTEM_PROMPT),
      new HumanMessage(`# Task\n${state.task}${contextBlock}`),
    ]);
```

with

```ts
    const { raw, parsed } = await structured.invoke(
      [new SystemMessage(SYSTEM_PROMPT), new HumanMessage(`# Task\n${state.task}${contextBlock}`)],
      withUsage("proposeCriteria"),
    );
```

`architect.ts`, `builder.ts`, `critic.ts`, `worker.ts`, `lead.ts` — each has exactly one line

```ts
        { signal: config?.signal },
```

inside its `withLlmTimeout(…invoke(…))` call. Replace it with the file's role:

| File | Replacement |
|---|---|
| `architect.ts` | `        withUsage("architect", { signal: config?.signal }),` |
| `builder.ts` | `        withUsage("builder", { signal: config?.signal }),` |
| `critic.ts` | `        withUsage("critic", { signal: config?.signal }),` |
| `worker.ts` | `        withUsage("worker", { signal: config?.signal }),` |
| `lead.ts` | `        withUsage("lead", { signal: config?.signal }),` |

In `architect.ts`, leave the `surveyRepo({ … signal: config?.signal })` call alone. The survey tags itself in Task 4.

`analyst.ts` — replace

```ts
      const ai = await modelWithTools.invoke(messages);
```

with

```ts
      const ai = await modelWithTools.invoke(messages, withUsage("analyst"));
```

`implementer.ts` — replace

```ts
          { recursionLimit: RECURSION_LIMIT, signal: config?.signal },
```

with

```ts
          withUsage("implementer", { recursionLimit: RECURSION_LIMIT, signal: config?.signal }),
```

`missionCritic.ts` — replace

```ts
      const { raw, parsed } = await structuredBinary.invoke([
        new SystemMessage(SYSTEM_PROMPT),
        new HumanMessage(prompt),
      ]);
```

with

```ts
      const { raw, parsed } = await structuredBinary.invoke(
        [new SystemMessage(SYSTEM_PROMPT), new HumanMessage(prompt)],
        withUsage("missionCritic"),
      );
```

and replace

```ts
    const { raw, parsed } = await structuredRubric.invoke([
      new SystemMessage(RUBRIC_SYSTEM_PROMPT),
      new HumanMessage(prompt),
    ]);
```

with

```ts
    const { raw, parsed } = await structuredRubric.invoke(
      [new SystemMessage(RUBRIC_SYSTEM_PROMPT), new HumanMessage(prompt)],
      withUsage("missionCritic"),
    );
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @arzonic/agent-core exec tsx verify-usage-nodes.ts`
Expected: all `ok: …`, ending with `Every graph node tags its model calls ✓`.

Then check that the node behaviour itself is unchanged:
`pnpm --filter @arzonic/agent-core exec tsx verify-graph-nodes.ts && pnpm --filter @arzonic/agent-core exec tsx verify-mission-team.ts && pnpm --filter @arzonic/agent-core exec tsx verify-implementer.ts && pnpm --filter @arzonic/agent-core exec tsx verify-rubric.ts`
Expected: each ends with its `✓` line.

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm --filter @arzonic/agent-core typecheck`
Expected: exits 0.

```bash
git add packages/core/src/nodes/router.ts packages/core/src/nodes/proposeCriteria.ts packages/core/src/nodes/architect.ts packages/core/src/nodes/builder.ts packages/core/src/nodes/critic.ts packages/core/src/nodes/worker.ts packages/core/src/nodes/lead.ts packages/core/src/nodes/analyst.ts packages/core/src/nodes/implementer.ts packages/core/src/nodes/missionCritic.ts packages/core/verify-usage-nodes.ts
git commit -m "$(cat <<'EOF'
feat(usage): every graph node tags the model calls it makes

Router, criteria proposer, architect, builder, critic, worker, lead,
analyst, implementer and mission critic now pass withUsage("<role>")
on their invoke config. Each keeps its signal and recursionLimit, so
behaviour is unchanged; the run's outer context still reaches the call.

Verified: verify-usage-nodes.ts runs each node alone in a one-node graph
with fakes and checks every call's role and the run's task id;
verify-graph-nodes, verify-mission-team, verify-implementer and
verify-rubric still pass.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Components outside a graph carry the runtime's callbacks

**Files:**
- Modify: `packages/core/src/nodes/repoSurvey.ts`, `decompose.ts`, `replan.ts`, `rubricAssessor.ts`, `testAuthor.ts`
- Test: `packages/core/verify-usage-components.ts`

**Interfaces:**
- Consumes: `withUsage`, `UsageContext` (Task 1); `WorkResult.attemptId` (Task 2); Task 1 fakes.
- Produces (new options — all optional, defaults keep today's behaviour):
  - `SurveyRepoOptions.callbacks?: Callbacks`, `SurveyRepoOptions.usageContext?: UsageContext`
  - `MakeDecomposerOptions.callbacks?: Callbacks`
  - `MakeReplannerOptions.callbacks?: Callbacks`
  - `MakeRubricAssessorOptions.callbacks?: Callbacks`
  - `MakeTestAuthorOptions.callbacks?: Callbacks`

- [ ] **Step 1: Write the failing test**

Create `packages/core/verify-usage-components.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @arzonic/agent-core exec tsx verify-usage-components.ts`
Expected: FAIL with `FAIL: calls are tagged ["survey"] (got [])`. The callbacks option does not exist yet, so nothing is recorded.

- [ ] **Step 3: Write the implementation**

`repoSurvey.ts`:

1. Under `import { billableTokens } from "../tokens.js";`, add:

```ts
import type { Callbacks } from "@langchain/core/callbacks/manager";
import { withUsage, type UsageContext } from "../usage.js";
```

2. In `interface SurveyRepoOptions`, after `signal?: AbortSignal;`, add:

```ts
  /**
   * Callback handlers for a survey that runs OUTSIDE a graph (the mission
   * worker, the decomposer). Inside a graph node leave it unset — the node's
   * run already carries them.
   */
  callbacks?: Callbacks;
  /** Attribution for a survey outside a graph run, e.g. `{ missionId }`. */
  usageContext?: UsageContext;
```

3. In `surveyRepo`, replace

```ts
        { recursionLimit: RECURSION_LIMIT, signal },
```

with

```ts
        withUsage(
          "survey",
          { recursionLimit: RECURSION_LIMIT, signal, callbacks: options.callbacks },
          options.usageContext,
        ),
```

`decompose.ts`:

1. Under `import { billableTokens } from "../tokens.js";`, add:

```ts
import type { Callbacks } from "@langchain/core/callbacks/manager";
import { withUsage } from "../usage.js";
```

2. In `interface MakeDecomposerOptions`, after `llmCallTimeoutMs?: number;`, add:

```ts
  /** The runtime's callback handlers (e.g. the usage recorder). The decomposer runs outside any graph, so it passes them itself. */
  callbacks?: Callbacks;
```

3. Replace `const { repo, survey: providedSurvey, llmCallTimeoutMs } = options;` with:

```ts
  const { repo, survey: providedSurvey, llmCallTimeoutMs, callbacks } = options;
```

4. In the `surveyRepo({ … })` call inside `decompose`, add these two properties after `llmCallTimeoutMs,`:

```ts
            callbacks,
            usageContext: { missionId: input.mission.id },
```

5. Replace

```ts
      const { raw, parsed } = await structured.invoke([
        new SystemMessage(SYSTEM_PROMPT + (surveyed.survey ? GROUNDED_PROMPT : "")),
        new HumanMessage(prompt),
      ]);
```

with

```ts
      const { raw, parsed } = await structured.invoke(
        [
          new SystemMessage(SYSTEM_PROMPT + (surveyed.survey ? GROUNDED_PROMPT : "")),
          new HumanMessage(prompt),
        ],
        withUsage("decompose", { callbacks }, { missionId: input.mission.id }),
      );
```

`replan.ts`:

1. Under `import { billableTokens } from "../tokens.js";`, add:

```ts
import type { Callbacks } from "@langchain/core/callbacks/manager";
import { withUsage } from "../usage.js";
```

2. In `interface MakeReplannerOptions`, add:

```ts
  /** The runtime's callback handlers (e.g. the usage recorder). The replanner runs outside any graph, so it passes them itself. */
  callbacks?: Callbacks;
```

3. Replace

```ts
      const { raw, parsed } = await structured.invoke([
        new SystemMessage(SYSTEM_PROMPT),
        new HumanMessage(buildPrompt(input, titles)),
      ]);
```

with

```ts
      const { raw, parsed } = await structured.invoke(
        [new SystemMessage(SYSTEM_PROMPT), new HumanMessage(buildPrompt(input, titles))],
        withUsage(
          "replan",
          { callbacks: options.callbacks },
          { missionId: input.mission.id, itemId: input.item.id, attemptId: input.result.attemptId },
        ),
      );
```

`rubricAssessor.ts`:

1. Under `import { billableTokens } from "../tokens.js";`, add:

```ts
import type { Callbacks } from "@langchain/core/callbacks/manager";
import { withUsage } from "../usage.js";
```

2. In `interface MakeRubricAssessorOptions`, after the `evidence` field, add:

```ts
  /** The runtime's callback handlers (e.g. the usage recorder). The assessor runs outside any graph, so it passes them itself. */
  callbacks?: Callbacks;
```

3. Replace

```ts
      const { raw, parsed } = await structured.invoke([
        new SystemMessage(SYSTEM_PROMPT),
        new HumanMessage(prompt),
      ]);
```

with

```ts
      const { raw, parsed } = await structured.invoke(
        [new SystemMessage(SYSTEM_PROMPT), new HumanMessage(prompt)],
        withUsage("rubricAssessor", { callbacks: options.callbacks }, { missionId: mission.id }),
      );
```

(`assess` destructures `{ mission, rubric, doneCount }`, so `mission` is in scope.)

`testAuthor.ts`:

1. Under `import { billableTokens } from "../tokens.js";`, add:

```ts
import type { Callbacks } from "@langchain/core/callbacks/manager";
import { withUsage } from "../usage.js";
```

2. In `interface MakeTestAuthorOptions`, after the `repo` field, add:

```ts
  /** The runtime's callback handlers (e.g. the usage recorder). The test author runs outside any graph, so it passes them itself. */
  callbacks?: Callbacks;
```

3. Replace

```ts
          { recursionLimit: RECURSION_LIMIT },
```

with

```ts
          withUsage(
            "tester",
            { recursionLimit: RECURSION_LIMIT, callbacks: options.callbacks },
            { missionId: input.mission.id, itemId: input.item.id, attemptId: input.result.attemptId },
          ),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @arzonic/agent-core exec tsx verify-usage-components.ts`
Expected: all `ok: …`, ending with `Components outside a graph are attributed ✓`.

Then run the existing proofs for the five components:
`pnpm --filter @arzonic/agent-core exec tsx verify-decompose.ts && pnpm --filter @arzonic/agent-core exec tsx verify-replan.ts && pnpm --filter @arzonic/agent-core exec tsx verify-tester.ts && pnpm --filter @arzonic/agent-core exec tsx verify-grounded-planning.ts && pnpm --filter @arzonic/agent-core exec tsx verify-item-check.ts`
Expected: each ends with its `✓` line.

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm --filter @arzonic/agent-core typecheck`
Expected: exits 0.

```bash
git add packages/core/src/nodes/repoSurvey.ts packages/core/src/nodes/decompose.ts packages/core/src/nodes/replan.ts packages/core/src/nodes/rubricAssessor.ts packages/core/src/nodes/testAuthor.ts packages/core/verify-usage-components.ts
git commit -m "$(cat <<'EOF'
feat(usage): components outside a graph carry the runtime's callbacks

Survey, decomposer, replanner, rubric assessor and test author run
outside any graph, so nothing above them carries the usage recorder.
Each takes an optional `callbacks` option and tags its calls with its
role and the mission, item and attempt it reads off its own input — the
replanner and test author use WorkResult.attemptId. Leaving the option
unset keeps today's behaviour exactly.

Verified: verify-usage-components.ts (incl. a decomposer that surveys by
itself); verify-decompose, verify-replan, verify-tester,
verify-grounded-planning and verify-item-check still pass.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Price table

**Files:**
- Create: `packages/shared/src/pricing.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/verify-pricing.ts`

**Interfaces:**
- Produces: `PRICE_TABLE_VERSION: string`, `interface ModelPrice { input; output; cacheWrite; cacheRead }` (USD per 1M tokens), `interface TokenCounts { inputFresh; cacheWrite; cacheRead; output }`, `priceFor(model: string | null | undefined): ModelPrice | null`, `estimateCostUsd(model, counts: TokenCounts): number | null`.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/verify-pricing.ts`:

```ts
/**
 * Proof that the price table prices known models from their list price, matches
 * dated model ids to their family, and leaves a model without a verified price
 * unknown (null) instead of free. Pure — no key, no DB.
 * Run: pnpm --filter @arzonic/agent-shared exec tsx verify-pricing.ts
 */
import { PRICE_TABLE_VERSION, estimateCostUsd, priceFor } from "./src/pricing.js";

const ok = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`ok: ${message}`);
};

const none = { inputFresh: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
const M = 1_000_000;

ok(estimateCostUsd("claude-sonnet-4-6", { ...none, inputFresh: M }) === 3, "Sonnet 4.6 input is $3 per 1M");
ok(estimateCostUsd("claude-sonnet-4-6", { ...none, output: M }) === 15, "Sonnet 4.6 output is $15 per 1M");
ok(estimateCostUsd("claude-sonnet-4-6", { ...none, cacheRead: M }) === 0.3, "Sonnet 4.6 cache reads are $0.30 per 1M");
ok(estimateCostUsd("claude-sonnet-4-6", { ...none, cacheWrite: M }) === 3.75, "Sonnet 4.6 cache writes are $3.75 per 1M (5-minute TTL)");
ok(estimateCostUsd("claude-sonnet-4-6-20260101", { ...none, output: M }) === 15, "a dated model id prices like its family");
ok(estimateCostUsd("claude-opus-5-5", { ...none, cacheRead: M }) === 0.2, "Opus 5.5 cache reads are $0.20 per 1M");
ok(estimateCostUsd("claude-sonnet-5-5", { ...none, inputFresh: M, output: M }) === 12, "Sonnet 5.5: $2 in + $10 out");
ok(estimateCostUsd("claude-haiku-4-5", { ...none, inputFresh: M }) === 1, "Haiku 4.5 input is $1 per 1M");
ok(
  estimateCostUsd("mistral-large-latest", { ...none, inputFresh: 2 * M, output: M }) === 2.5,
  "Mistral Large 3: 2M in + 1M out = $2.50",
);
ok(estimateCostUsd("gemini-2.5-flash", { ...none, inputFresh: M }) === null, "a model without a verified price is unknown, not free");
ok(estimateCostUsd(null, { ...none, inputFresh: M }) === null, "no model, no price");
ok(priceFor("CLAUDE-HAIKU-4-5")?.input === 1, "matching ignores case");
ok(/^\d{4}-\d{2}-\d{2}$/.test(PRICE_TABLE_VERSION), "the table carries the date its prices were checked");

console.log("\nPrice table ✓");
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @arzonic/agent-shared exec tsx verify-pricing.ts`
Expected: FAIL with `Cannot find module './src/pricing.js'`.

- [ ] **Step 3: Write the implementation**

Create `packages/shared/src/pricing.ts`:

```ts
/**
 * Estimated USD price of a model call, from the provider's list price per
 * million tokens. This is the price the usage ledger stores next to the raw token
 * counts — so models can be compared on money, not on the budget's token unit
 * (billableTokens weights cache reads and writes but prices every output token
 * like an input token).
 *
 * Only prices verified on PRICE_TABLE_VERSION are listed. A model that isn't
 * listed has an UNKNOWN price (null), never 0: a zero would quietly make an
 * unpriced model look free. Adding one is a single row — never a guess.
 *
 * Sources (checked 2026-10-07): Anthropic's list prices (cache writes at the
 * 5-minute TTL, 1.25× input), Mistral Large 3 (2512) at $0.50 / $1.50.
 */
export const PRICE_TABLE_VERSION = "2026-10-07";

/** USD per 1M tokens, per token class. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/** A call's tokens, split the way providers bill them. */
export interface TokenCounts {
  inputFresh: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

/** Longest matching prefix wins, so a dated id (claude-sonnet-4-6-2026…) prices like its family. */
const PRICES: ReadonlyArray<readonly [prefix: string, price: ModelPrice]> = [
  ["claude-opus-5-5", { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 }],
  ["claude-sonnet-5-5", { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 }],
  ["claude-sonnet-4-6", { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 }],
  ["claude-haiku-4-5", { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 }],
  // Mistral reports no cache classes; both are priced as input to stay safe.
  ["mistral-large-2512", { input: 0.5, output: 1.5, cacheWrite: 0.5, cacheRead: 0.5 }],
  // `-latest` pointed at Large 3 (2512) on PRICE_TABLE_VERSION. Re-check when Mistral moves it.
  ["mistral-large-latest", { input: 0.5, output: 1.5, cacheWrite: 0.5, cacheRead: 0.5 }],
];

/** The list price for a model id, or null when it has no verified price. */
export function priceFor(model: string | null | undefined): ModelPrice | null {
  if (!model) return null;
  const id = model.trim().toLowerCase();
  let best: ModelPrice | null = null;
  let bestLength = -1;
  for (const [prefix, price] of PRICES) {
    if (id.startsWith(prefix) && prefix.length > bestLength) {
      best = price;
      bestLength = prefix.length;
    }
  }
  return best;
}

/** Estimated USD for one call, rounded to a millionth of a dollar; null when the model has no price. */
export function estimateCostUsd(model: string | null | undefined, counts: TokenCounts): number | null {
  const price = priceFor(model);
  if (!price) return null;
  const usd =
    (counts.inputFresh * price.input +
      counts.cacheWrite * price.cacheWrite +
      counts.cacheRead * price.cacheRead +
      counts.output * price.output) /
    1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}
```

In `packages/shared/src/index.ts`, add at the end:

```ts
export {
  PRICE_TABLE_VERSION,
  priceFor,
  estimateCostUsd,
  type ModelPrice,
  type TokenCounts,
} from "./pricing.js";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @arzonic/agent-shared exec tsx verify-pricing.ts`
Expected: all `ok: …`, ending with `Price table ✓`.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/pricing.ts packages/shared/src/index.ts packages/shared/verify-pricing.ts
git commit -m "$(cat <<'EOF'
feat(usage): a dated price table for estimating what a call cost

priceFor() and estimateCostUsd() price a call from its raw token classes
at the provider's list price. Only prices checked on 2026-10-07 are
listed (Claude Opus 5.5, Sonnet 5.5, Sonnet 4.6, Haiku 4.5; Mistral
Large 3); anything else is an unknown price — null, never 0 — so an
unpriced model can't pass for a free one.

Verified: verify-pricing.ts.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: The usage recorder

**Files:**
- Create: `packages/shared/src/usageRecorder.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/verify-usage-recorder.ts`

**Interfaces:**
- Consumes: `USAGE_METADATA_KEYS`, `billableTokens`, `UsageMetadataLike` from `@arzonic/agent-core` (Tasks 1 and existing); `estimateCostUsd`, `TokenCounts` (Task 5).
- Produces:
  - `interface UsageRow` (fields: `callId, at, missionId, itemId, attemptId, taskId, role, provider, model, status: "ok" | "error" | "dropped", calls, usageKnown, inputFresh, cacheWrite, cacheRead, output, billable, costUsd, latencyMs`; nullable as in the spec)
  - `type UsageInsertResult = "inserted" | "duplicate" | "rejected"`
  - `interface UsageSink { insert(row: UsageRow): Promise<UsageInsertResult> }` — throwing means "unreachable, retry later".
  - `interface UsageRecorder { handler; flush(); stats(); close() }`
  - `interface UsageRecorderStats { buffered; written; rejected; dropped }`
  - `createUsageRecorder(sink: UsageSink, options?: UsageRecorderOptions): UsageRecorder`

- [ ] **Step 1: Build core so shared sees Tasks 1–4**

Run: `pnpm --filter @arzonic/agent-core build`
Expected: exits 0.

- [ ] **Step 2: Write the failing test**

Create `packages/shared/verify-usage-recorder.ts`:

```ts
/**
 * Proof that the usage recorder turns every chat-model call into exactly one
 * ledger row — with the role and ids from the run's metadata, the provider's
 * token classes, the budget weighting and an estimated price — and that a
 * missing number stays unknown instead of becoming zero. Also proves the writer
 * never loses a call silently: an unreachable ledger keeps rows and retries, a
 * row the ledger rejects is counted, and an overflow leaves a gap row behind.
 * Fakes only — no key, no DB.
 * Run: pnpm --filter @arzonic/agent-shared exec tsx verify-usage-recorder.ts
 */
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { withUsage, type UsageRole } from "@arzonic/agent-core";
import {
  createUsageRecorder,
  type UsageInsertResult,
  type UsageRecorder,
  type UsageRow,
  type UsageSink,
} from "./src/usageRecorder.js";

const ok = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`ok: ${message}`);
};

const MISSION = "11111111-1111-4111-8111-111111111111";
const ITEM = "22222222-2222-4222-8222-222222222222";
const ATTEMPT = "33333333-3333-4333-8333-333333333333";
const ctx = { missionId: MISSION, itemId: ITEM, attemptId: ATTEMPT };

/** A Claude-shaped reply: cache read + write, and the served model id. */
class ChatCached extends BaseChatModel {
  _llmType(): string {
    return "fake-cached";
  }
  async _generate(): Promise<ChatResult> {
    const message = new AIMessage({
      content: "ok",
      usage_metadata: {
        input_tokens: 1000,
        output_tokens: 200,
        total_tokens: 1200,
        input_token_details: { cache_read: 600, cache_creation: 100 },
      },
      response_metadata: { model: "claude-sonnet-4-6" },
    });
    return { generations: [{ text: "ok", message }] };
  }
}

/** A provider that reports no usage at all. */
class ChatSilent extends BaseChatModel {
  _llmType(): string {
    return "fake-silent";
  }
  async _generate(): Promise<ChatResult> {
    return { generations: [{ text: "ok", message: new AIMessage({ content: "ok" }) }] };
  }
}

/** A provider that fails the call. */
class ChatBroken extends BaseChatModel {
  _llmType(): string {
    return "fake-broken";
  }
  async _generate(): Promise<ChatResult> {
    throw new Error("provider exploded");
  }
}

/** In-memory ledger: dedupes on callId like the real table, can go down or reject one role. */
class MemorySink implements UsageSink {
  readonly rows = new Map<string, UsageRow>();
  down = false;
  rejectRole: string | null = null;
  async insert(row: UsageRow): Promise<UsageInsertResult> {
    if (this.down) throw new Error("connection refused");
    if (row.role === this.rejectRole) return "rejected";
    if (this.rows.has(row.callId)) return "duplicate";
    this.rows.set(row.callId, row);
    return "inserted";
  }
}

const quiet = (): ((message: string) => void) => () => {};

async function call(
  model: BaseChatModel,
  role: UsageRole,
  handler: UsageRecorder["handler"],
  withCtx = true,
): Promise<void> {
  await model.invoke([new HumanMessage(role)], withUsage(role, { callbacks: [handler] }, withCtx ? ctx : {}));
}

// ── 1. One call, one row: attributed, split and priced ──
{
  const sink = new MemorySink();
  const recorder = createUsageRecorder(sink, { flushIntervalMs: 60_000, log: quiet() });
  await call(new ChatCached({}), "implementer", recorder.handler);
  await recorder.flush();
  const rows = [...sink.rows.values()];
  const row = rows[0]!;
  ok(rows.length === 1, "one call, one row");
  ok(
    row.role === "implementer" && row.missionId === MISSION && row.itemId === ITEM && row.attemptId === ATTEMPT,
    "role, mission, item and attempt come from the run's metadata",
  );
  ok(row.model === "claude-sonnet-4-6", "the model that answered is recorded");
  ok(
    row.inputFresh === 300 && row.cacheWrite === 100 && row.cacheRead === 600 && row.output === 200,
    "tokens split into fresh input, cache write, cache read and output",
  );
  ok(row.billable === 685, "billable uses the budget's weighting: 300 + 1.25×100 + 0.1×600 + 200");
  ok(row.costUsd === 0.004455, `the price follows the table ($${row.costUsd})`);
  ok(
    row.status === "ok" && row.usageKnown && row.calls === 1 && (row.latencyMs ?? -1) >= 0,
    "status ok, usage known, one call, a latency",
  );
  await recorder.close();
}

// ── 2. No usage reported: unknown, not zero ──
{
  const sink = new MemorySink();
  const recorder = createUsageRecorder(sink, { flushIntervalMs: 60_000, log: quiet() });
  await call(new ChatSilent({}), "router", recorder.handler, false);
  await recorder.flush();
  const row = [...sink.rows.values()][0];
  ok(row?.usageKnown === false, "a reply without usage is marked unknown");
  ok(
    row?.inputFresh === null && row.output === null && row.billable === null && row.costUsd === null,
    "unknown counts are null, never 0",
  );
  await recorder.close();
}

// ── 3. A failing call is an error row, and the error still reaches the caller ──
{
  const sink = new MemorySink();
  const recorder = createUsageRecorder(sink, { flushIntervalMs: 60_000, log: quiet() });
  let thrown = "";
  try {
    await call(new ChatBroken({ maxRetries: 0 }), "critic", recorder.handler);
  } catch (err) {
    thrown = err instanceof Error ? err.message : String(err);
  }
  await recorder.flush();
  const row = [...sink.rows.values()][0];
  ok(thrown.includes("provider exploded"), "the recorder does not swallow the model's error");
  ok(
    row?.status === "error" && row.usageKnown === false && row.role === "critic",
    "the failed call is in the ledger as an error with unknown usage",
  );
  await recorder.close();
}

// ── 4. Ledger down: rows wait in memory and are written exactly once when it returns ──
{
  const sink = new MemorySink();
  const logs: string[] = [];
  const recorder = createUsageRecorder(sink, { flushIntervalMs: 60_000, log: (m) => logs.push(m) });
  sink.down = true;
  await call(new ChatCached({}), "replan", recorder.handler);
  await recorder.flush();
  await recorder.flush();
  ok(recorder.stats().buffered === 1 && sink.rows.size === 0, "while the ledger is down the call waits in memory");
  ok(logs.filter((l) => l.includes("unavailable")).length === 1, "an outage is logged once, not on every flush");
  sink.down = false;
  await recorder.flush();
  await recorder.flush();
  ok(
    sink.rows.size === 1 && recorder.stats().buffered === 0 && recorder.stats().written === 1,
    "the waiting call is written exactly once",
  );
  await recorder.close();
}

// ── 5. A rejected row is counted and does not block the rows behind it ──
{
  const sink = new MemorySink();
  sink.rejectRole = "survey";
  const recorder = createUsageRecorder(sink, { flushIntervalMs: 60_000, log: quiet() });
  const model = new ChatCached({});
  await call(model, "survey", recorder.handler);
  await call(model, "decompose", recorder.handler);
  await recorder.flush();
  ok(
    recorder.stats().rejected === 1 && sink.rows.size === 1 && [...sink.rows.values()][0]!.role === "decompose",
    "the rejected row is counted and the next one is written",
  );
  await recorder.close();
}

// ── 6. Overflow leaves a gap row, so a lost call is visible instead of silent ──
{
  const sink = new MemorySink();
  const recorder = createUsageRecorder(sink, { flushIntervalMs: 60_000, maxBuffered: 2, log: quiet() });
  sink.down = true;
  const model = new ChatCached({});
  for (const role of ["implementer", "missionCritic", "replan"] as const) {
    await call(model, role, recorder.handler);
  }
  ok(recorder.stats().dropped === 1 && recorder.stats().buffered === 2, "the oldest call is dropped when the buffer is full");
  sink.down = false;
  await recorder.flush();
  const rows = [...sink.rows.values()];
  const gap = rows.find((r) => r.status === "dropped");
  ok(
    rows.length === 3 && gap?.calls === 1 && gap.missionId === MISSION && gap.usageKnown === false,
    "a gap row stands in for the dropped call, on its mission",
  );
  await recorder.close();
}

// ── 7. close() writes what is left ──
{
  const sink = new MemorySink();
  const recorder = createUsageRecorder(sink, { flushIntervalMs: 60_000, log: quiet() });
  await call(new ChatCached({}), "tester", recorder.handler);
  await recorder.close();
  ok(sink.rows.size === 1, "close() flushes the last calls");
}

console.log("\nUsage recorder ✓");
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @arzonic/agent-shared exec tsx verify-usage-recorder.ts`
Expected: FAIL with `Cannot find module './src/usageRecorder.js'`.

- [ ] **Step 4: Write the implementation**

Create `packages/shared/src/usageRecorder.ts`:

```ts
/**
 * Records every chat-model call into the usage ledger: one row per call,
 * attributed from the run's metadata (role, mission, item, attempt, task — see
 * core's usage.ts) and split into the provider's token classes, with the
 * budget's weighting and an estimated price next to the raw counts.
 *
 * Attach `recorder.handler` as an inheritable callback at the OUTERMOST invoke.
 * The handler only pushes onto an in-memory buffer, so it can never fail or slow
 * a model call; a timer flushes the buffer to the ledger. Writes are idempotent
 * (one row per LangChain run id), an unreachable ledger keeps rows and retries,
 * and calls lost to an overflow leave a gap row — a missing measurement is
 * visible, never a silent zero.
 */
import { randomUUID } from "node:crypto";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Serialized } from "@langchain/core/load/serializable";
import type { BaseMessage } from "@langchain/core/messages";
import type { LLMResult } from "@langchain/core/outputs";
import { USAGE_METADATA_KEYS as K, billableTokens, type UsageMetadataLike } from "@arzonic/agent-core";
import { estimateCostUsd, type TokenCounts } from "./pricing.js";

/** One model call as the ledger stores it. Token fields are null when unknown — never 0. */
export interface UsageRow {
  /** The LangChain run id of the call (a uuid) — one row per call, so a retry never double counts. */
  callId: string;
  at: Date;
  missionId: string | null;
  itemId: string | null;
  attemptId: string | null;
  taskId: string | null;
  role: string;
  provider: string | null;
  model: string | null;
  /** "ok" or "error" for a call; "dropped" for a gap row standing in for calls that could not be stored. */
  status: "ok" | "error" | "dropped";
  /** 1 for a call; the number of lost calls on a gap row. */
  calls: number;
  usageKnown: boolean;
  inputFresh: number | null;
  cacheWrite: number | null;
  cacheRead: number | null;
  output: number | null;
  /** Same weighting as core's billableTokens — comparable with the mission budget. */
  billable: number | null;
  costUsd: number | null;
  latencyMs: number | null;
}

/** "rejected" = this row can never be stored (e.g. its mission was deleted). Throwing = unreachable, retry later. */
export type UsageInsertResult = "inserted" | "duplicate" | "rejected";

export interface UsageSink {
  insert(row: UsageRow): Promise<UsageInsertResult>;
}

export interface UsageRecorderStats {
  /** Calls waiting in memory for the ledger. */
  buffered: number;
  /** Rows the ledger accepted. */
  written: number;
  /** Rows the ledger refused for good. */
  rejected: number;
  /** Calls dropped because the buffer was full (each later written as part of a gap row). */
  dropped: number;
}

export interface UsageRecorder {
  /** Attach as an inheritable callback at the top-level invoke: `{ callbacks: [recorder.handler] }`. */
  readonly handler: BaseCallbackHandler;
  /** Write everything buffered now. Never throws. */
  flush(): Promise<void>;
  stats(): UsageRecorderStats;
  /** Stop the timer and write what is left. */
  close(): Promise<void>;
}

export interface UsageRecorderOptions {
  /** How often the buffer is written. Default 1 s. */
  flushIntervalMs?: number;
  /** Most calls kept while the ledger is unreachable before the oldest are dropped. Default 5000. */
  maxBuffered?: number;
  /** Where problems are reported. Default console.warn. */
  log?: (message: string) => void;
  /** Clock, for tests. Default Date.now. */
  now?: () => number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = (value: unknown): string | null =>
  typeof value === "string" && UUID.test(value) ? value : null;
const textOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

interface CallStart {
  at: number;
  metadata: Record<string, unknown>;
}

interface MessageLike {
  usage_metadata?: UsageMetadataLike;
  response_metadata?: Record<string, unknown>;
}

interface Measured {
  counts: TokenCounts;
  usage: UsageMetadataLike;
}

/** The call's token counts — null when the provider reported none (unknown is not zero). */
function measure(message: MessageLike | undefined, llmOutput: Record<string, unknown> | undefined): Measured | null {
  const usage = message?.usage_metadata;
  if (usage && (usage.input_tokens !== undefined || usage.output_tokens !== undefined)) {
    const input = usage.input_tokens ?? 0;
    const cacheWrite = usage.input_token_details?.cache_creation ?? 0;
    const cacheRead = usage.input_token_details?.cache_read ?? 0;
    return {
      // LangChain folds both cache classes into input_tokens; the remainder is fresh.
      counts: { inputFresh: Math.max(0, input - cacheWrite - cacheRead), cacheWrite, cacheRead, output: usage.output_tokens ?? 0 },
      usage,
    };
  }
  // Older integrations report only llmOutput.tokenUsage — no cache split.
  const legacy = llmOutput?.tokenUsage as { promptTokens?: number; completionTokens?: number } | undefined;
  if (legacy && (legacy.promptTokens !== undefined || legacy.completionTokens !== undefined)) {
    const usage = { input_tokens: legacy.promptTokens ?? 0, output_tokens: legacy.completionTokens ?? 0 };
    return {
      counts: { inputFresh: usage.input_tokens, cacheWrite: 0, cacheRead: 0, output: usage.output_tokens },
      usage,
    };
  }
  return null;
}

function callRow(
  callId: string,
  start: CallStart,
  endedAt: number,
  status: "ok" | "error",
  message?: MessageLike,
  llmOutput?: Record<string, unknown>,
): UsageRow {
  const metadata = start.metadata;
  const measured = status === "ok" ? measure(message, llmOutput) : null;
  // The model that actually answered beats the one asked for: "-latest" aliases move.
  const model =
    textOrNull(message?.response_metadata?.model) ??
    textOrNull(message?.response_metadata?.model_name) ??
    textOrNull(metadata.ls_model_name);
  return {
    callId: uuidOrNull(callId) ?? randomUUID(),
    at: new Date(endedAt),
    missionId: uuidOrNull(metadata[K.missionId]),
    itemId: uuidOrNull(metadata[K.itemId]),
    attemptId: uuidOrNull(metadata[K.attemptId]),
    taskId: uuidOrNull(metadata[K.taskId]),
    role: textOrNull(metadata[K.role]) ?? textOrNull(metadata.langgraph_node) ?? "unknown",
    provider: textOrNull(metadata.ls_provider),
    model,
    status,
    calls: 1,
    usageKnown: measured !== null,
    inputFresh: measured?.counts.inputFresh ?? null,
    cacheWrite: measured?.counts.cacheWrite ?? null,
    cacheRead: measured?.counts.cacheRead ?? null,
    output: measured?.counts.output ?? null,
    billable: measured ? billableTokens(measured.usage) : null,
    costUsd: measured ? estimateCostUsd(model, measured.counts) : null,
    latencyMs: Math.max(0, Math.round(endedAt - start.at)),
  };
}

/** Stands in for calls lost to an overflow, so the ledger shows that something is missing. */
function gapRow(missionId: string | null, taskId: string | null, calls: number, at: number): UsageRow {
  return {
    callId: randomUUID(),
    at: new Date(at),
    missionId,
    itemId: null,
    attemptId: null,
    taskId,
    role: "unrecorded",
    provider: null,
    model: null,
    status: "dropped",
    calls,
    usageKnown: false,
    inputFresh: null,
    cacheWrite: null,
    cacheRead: null,
    output: null,
    billable: null,
    costUsd: null,
    latencyMs: null,
  };
}

class UsageCallbackHandler extends BaseCallbackHandler {
  name = "agent_engine_usage";
  private readonly started = new Map<string, CallStart>();

  constructor(
    private readonly record: (row: UsageRow) => void,
    private readonly now: () => number,
  ) {
    // Awaited, so a call's row is buffered before invoke() resolves. Recording is a
    // synchronous push, so awaiting it costs the call nothing.
    super({ _awaitHandler: true });
  }

  override handleChatModelStart(
    _llm: Serialized,
    _messages: BaseMessage[][],
    runId: string,
    _parentRunId?: string,
    _extraParams?: Record<string, unknown>,
    _tags?: string[],
    metadata?: Record<string, unknown>,
  ): void {
    this.started.set(runId, { at: this.now(), metadata: metadata ?? {} });
  }

  override handleLLMEnd(output: LLMResult, runId: string): void {
    const start = this.take(runId);
    if (!start) return;
    const message = (output.generations?.[0]?.[0] as { message?: MessageLike } | undefined)?.message;
    this.record(callRow(runId, start, this.now(), "ok", message, output.llmOutput));
  }

  override handleLLMError(_err: unknown, runId: string): void {
    const start = this.take(runId);
    if (!start) return;
    this.record(callRow(runId, start, this.now(), "error"));
  }

  private take(runId: string): CallStart | undefined {
    const start = this.started.get(runId);
    this.started.delete(runId);
    return start;
  }
}

export function createUsageRecorder(sink: UsageSink, options: UsageRecorderOptions = {}): UsageRecorder {
  const flushIntervalMs = options.flushIntervalMs ?? 1_000;
  const maxBuffered = options.maxBuffered ?? 5_000;
  const log = options.log ?? ((message: string) => console.warn(message));
  const now = options.now ?? (() => Date.now());

  const buffer: UsageRow[] = [];
  /** Calls dropped on overflow, per mission/run, still owed to the ledger as gap rows. */
  const owed = new Map<string, { missionId: string | null; taskId: string | null; calls: number }>();
  let written = 0;
  let rejected = 0;
  let dropped = 0;
  let unavailable = false;
  let inFlight: Promise<void> | null = null;

  const record = (row: UsageRow): void => {
    buffer.push(row);
    if (buffer.length <= maxBuffered) return;
    const lost = buffer.shift()!;
    dropped += 1;
    const key = `${lost.missionId ?? ""}|${lost.taskId ?? ""}`;
    const gap = owed.get(key) ?? { missionId: lost.missionId, taskId: lost.taskId, calls: 0 };
    gap.calls += lost.calls;
    owed.set(key, gap);
  };

  /** One insert. false = the ledger is unreachable: stop and retry on the next flush. */
  const store = async (row: UsageRow): Promise<boolean> => {
    try {
      const result = await sink.insert(row);
      if (unavailable) {
        unavailable = false;
        log("[usage] ledger reachable again — writing the waiting calls.");
      }
      if (result === "inserted") written += 1;
      if (result === "rejected") {
        rejected += 1;
        log(`[usage] the ledger refused a ${row.role} call (${row.callId}) — its mission or item no longer exists.`);
      }
      return true;
    } catch (err) {
      if (!unavailable) {
        unavailable = true;
        log(`[usage] ledger unavailable, keeping calls in memory: ${err instanceof Error ? err.message : String(err)}`);
      }
      return false;
    }
  };

  const drain = async (): Promise<void> => {
    for (const [key, gap] of owed) {
      if (!(await store(gapRow(gap.missionId, gap.taskId, gap.calls, now())))) return;
      owed.delete(key);
    }
    while (buffer.length > 0) {
      if (!(await store(buffer[0]!))) return;
      buffer.shift();
    }
  };

  const flush = (): Promise<void> => {
    if (!inFlight) {
      inFlight = drain().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  };

  const timer = setInterval(() => void flush(), flushIntervalMs);
  timer.unref?.();

  return {
    handler: new UsageCallbackHandler(record, now),
    flush,
    stats: () => ({ buffered: buffer.length, written, rejected, dropped }),
    async close() {
      clearInterval(timer);
      await flush();
      // A call recorded while the previous drain was finishing.
      await flush();
    },
  };
}
```

In `packages/shared/src/index.ts`, add at the end:

```ts
export {
  createUsageRecorder,
  type UsageRow,
  type UsageSink,
  type UsageInsertResult,
  type UsageRecorder,
  type UsageRecorderStats,
  type UsageRecorderOptions,
} from "./usageRecorder.js";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @arzonic/agent-shared exec tsx verify-usage-recorder.ts`
Expected: all `ok: …`, ending with `Usage recorder ✓`.

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm --filter @arzonic/agent-shared typecheck`
Expected: exits 0.

```bash
git add packages/shared/src/usageRecorder.ts packages/shared/src/index.ts packages/shared/verify-usage-recorder.ts
git commit -m "$(cat <<'EOF'
feat(usage): record every chat-model call as one ledger row

createUsageRecorder() gives a LangChain callback handler that turns each
chat-model call into a UsageRow: attributed from the run's metadata,
split into fresh input / cache write / cache read / output, weighted
like the budget and priced from the table. A reply without usage stays
unknown (null), a failed call is an error row, and the error still
reaches the caller.

The handler only pushes to memory; a timer writes rows idempotently.
An unreachable ledger keeps them (logged once), a refused row is
counted, and an overflow leaves a gap row per mission/run.

Verified: verify-usage-recorder.ts (7 scenarios, fakes only).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: The Postgres ledger and its summaries

**Files:**
- Create: `packages/shared/src/usageLedger.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/verify-usage-ledger.ts` (needs the local Postgres)

**Interfaces:**
- Consumes: `UsageRow`, `UsageSink`, `UsageInsertResult` (Task 6); `PRICE_TABLE_VERSION` (Task 5).
- Produces: `class UsageLedgerService implements UsageSink` with `constructor({ connectionString })`, `setup()`, `insert(row)`, `missionSummary(missionId): Promise<UsageSummary>`, `taskSummary(taskId): Promise<UsageSummary>`, `end()`; types `UsageTotals`, `UsageByRole`, `UsageByItem`, `UsageOutcome`, `UsageSummary`:

```ts
interface UsageTotals {
  calls: number; unknownCalls: number; errorCalls: number; droppedCalls: number; unpricedCalls: number;
  inputFresh: number; cacheWrite: number; cacheRead: number; output: number;
  billable: number; costUsd: number;
}
interface UsageByRole extends UsageTotals { role: string; models: string[] }
interface UsageByItem { itemId: string; title: string; status: string; attempts: number; calls: number; billable: number; costUsd: number }
interface UsageOutcome {
  itemsDone: number; billableOnDone: number; billableOnOther: number; billableShared: number;
  billablePerDoneItem: number | null; costPerDoneItemUsd: number | null;
}
interface UsageSummary {
  totals: UsageTotals; byRole: UsageByRole[]; byItem: UsageByItem[]; outcome: UsageOutcome | null;
  budgetCounted: number | null; costComplete: boolean; firstCallAt: string | null; priceTableVersion: string;
}
```

- [ ] **Step 1: Start the local database**

Run: `docker compose up -d && docker exec agent-engine-pg pg_isready -U agent`
Expected: `accepting connections`. If the Docker daemon isn't running, ask the user to start Docker Desktop. Do not work around it.

Check that `.env` has `SUPABASE_DB_URL` pointing at it (the local-dev runbook uses `postgresql://agent:devpassword@localhost:5432/agent_engine`):
`grep -c '^SUPABASE_DB_URL=' .env`
Expected: `1`.

- [ ] **Step 2: Write the failing test**

Create `packages/shared/verify-usage-ledger.ts`:

```ts
/**
 * Proof that the Postgres usage ledger stores one row per call idempotently,
 * refuses rows whose mission is gone, and summarises a mission the way the panel
 * shows it: per role, per item (with attempts) and per finished item. Needs the
 * local Postgres (docker compose up -d) and SUPABASE_DB_URL in .env — like
 * verify-memory. Creates its own project and deletes it again (which cascades).
 * Run: pnpm --filter @arzonic/agent-shared exec tsx verify-usage-ledger.ts
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { BacklogService } from "./src/backlog.js";
import { loadEnv } from "./src/env.js";
import { MemoryService } from "./src/memory.js";
import { UsageLedgerService } from "./src/usageLedger.js";
import type { UsageRow } from "./src/usageRecorder.js";

const ok = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`ok: ${message}`);
};

const env = loadEnv();
if (!env.SUPABASE_DB_URL) {
  console.error("Need SUPABASE_DB_URL in .env (docker compose up -d).");
  process.exit(1);
}
const url = env.SUPABASE_DB_URL;

// Schema in dependency order: projects/tasks → missions/items → llm_usage.
// The memory key is unused here: setup() and the raw inserts never embed anything.
const memory = new MemoryService({ connectionString: url, mistralApiKey: "unused-by-this-script" });
await memory.setup();
const backlog = new BacklogService({ connectionString: url });
await backlog.setup();
const ledger = new UsageLedgerService({ connectionString: url });
await ledger.setup();
await ledger.setup(); // idempotent

const pool = new pg.Pool({ connectionString: url });
const projectId = randomUUID();
const taskId = randomUUID();
await pool.query(`INSERT INTO projects (id, name) VALUES ($1, 'usage-ledger-verify')`, [projectId]);

try {
  const mission = await backlog.createMission({ projectId, goal: "Verify the ledger", repoPath: "/tmp/usage-verify" });
  const done = await backlog.createItem({ missionId: mission.id, title: "Done item" });
  const failed = await backlog.createItem({ missionId: mission.id, title: "Failed item" });
  await backlog.updateItem(done.id, { status: "done" });
  await backlog.updateItem(failed.id, { status: "failed" });
  await backlog.updateMission(mission.id, { spentTokens: 999 });

  const [a1, a2, a3] = [randomUUID(), randomUUID(), randomUUID()];
  const unknown = { usageKnown: false, inputFresh: null, cacheWrite: null, cacheRead: null, output: null, billable: null, costUsd: null };
  const row = (over: Partial<UsageRow>): UsageRow => ({
    callId: randomUUID(),
    at: new Date(),
    missionId: mission.id,
    itemId: null,
    attemptId: null,
    taskId: null,
    role: "implementer",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    status: "ok",
    calls: 1,
    usageKnown: true,
    inputFresh: 100,
    cacheWrite: 0,
    cacheRead: 0,
    output: 50,
    billable: 150,
    costUsd: 0.00105,
    latencyMs: 10,
    ...over,
  });

  const first = row({ itemId: done.id, attemptId: a1 });
  ok((await ledger.insert(first)) === "inserted", "a row is inserted");
  ok((await ledger.insert(first)) === "duplicate", "the same call twice is a duplicate, not a second row");
  await ledger.insert(row({ itemId: done.id, attemptId: a1, role: "missionCritic", billable: 50, costUsd: 0.0005 }));
  await ledger.insert(row({ itemId: failed.id, attemptId: a2, billable: 300, costUsd: 0.002 }));
  await ledger.insert(row({ itemId: failed.id, attemptId: a3, billable: 300, costUsd: 0.002 }));
  await ledger.insert(row({ role: "survey", billable: 400, costUsd: 0.003 }));
  await ledger.insert(row({ role: "replan", ...unknown }));
  await ledger.insert(row({ role: "unrecorded", status: "dropped", calls: 3, provider: null, model: null, ...unknown }));
  await ledger.insert(row({ role: "decompose", model: "gemini-2.5-flash", billable: 10, costUsd: null }));
  ok(
    (await ledger.insert(row({ missionId: randomUUID() }))) === "rejected",
    "a row for a mission that does not exist is refused, not thrown",
  );

  const s = await ledger.missionSummary(mission.id);
  ok(s.totals.billable === 1210, `total billable sums every known call (got ${s.totals.billable})`);
  ok(
    s.totals.unknownCalls === 1 && s.totals.droppedCalls === 3 && s.totals.unpricedCalls === 1,
    "unknown, dropped and unpriced calls are counted, not hidden",
  );
  ok(s.byRole[0]?.role === "implementer" && s.byRole[0].billable === 750, "roles sort by spend: implementer 150 + 300 + 300");
  const doneRow = s.byItem.find((i) => i.itemId === done.id);
  const failedRow = s.byItem.find((i) => i.itemId === failed.id);
  ok(doneRow?.attempts === 1 && doneRow.billable === 200 && doneRow.status === "done", "the done item: 1 attempt, 200 tokens");
  ok(failedRow?.attempts === 2 && failedRow.billable === 600, "the failed item: 2 attempts, 600 tokens");
  ok(
    s.outcome?.itemsDone === 1 &&
      s.outcome.billableOnDone === 200 &&
      s.outcome.billableOnOther === 600 &&
      s.outcome.billableShared === 410,
    "the outcome splits done / not done / shared (survey + decompose)",
  );
  ok(s.outcome?.billablePerDoneItem === 1210, "per finished item counts everything, waste included");
  ok(s.budgetCounted === 999, "the budget's own count is reported next to the measured one");
  ok(s.costComplete === false, "the cost is marked incomplete while calls are unknown, dropped or unpriced");
  ok(s.firstCallAt !== null, "the first measured call is dated");

  const empty = await ledger.missionSummary(randomUUID());
  ok(empty.totals.calls === 0 && empty.byRole.length === 0 && empty.firstCallAt === null, "an unmeasured mission summarises to nothing");

  await ledger.insert(row({ missionId: null, taskId, role: "router", billable: 20 }));
  const t = await ledger.taskSummary(taskId);
  ok(t.totals.billable === 20 && t.outcome === null && t.byItem.length === 0, "a run without a project summarises by its task id");
} finally {
  // Cascades: project → missions → items → their llm_usage rows.
  await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  await pool.query(`DELETE FROM llm_usage WHERE task_id = $1`, [taskId]); // no FK on task_id, so no cascade
  await pool.end();
  await ledger.end();
  await backlog.end();
  await memory.end();
}

console.log("\nUsage ledger ✓");
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @arzonic/agent-shared exec tsx verify-usage-ledger.ts`
Expected: FAIL with `Cannot find module './src/usageLedger.js'`.

- [ ] **Step 4: Write the implementation**

Create `packages/shared/src/usageLedger.ts`:

```ts
/**
 * The usage ledger: one row per model call in Postgres (llm_usage), and the
 * summaries the dashboard shows — per role, per item and per finished item.
 *
 * Rows reference missions and backlog_items (ON DELETE CASCADE, like the rest
 * of the schema), so run setup() AFTER BacklogService.setup(). task_id has no
 * foreign key: a run without a project has an ad-hoc id with no tasks row.
 */
import pg from "pg";
import { PRICE_TABLE_VERSION } from "./pricing.js";
import type { UsageInsertResult, UsageRow, UsageSink } from "./usageRecorder.js";

const { Pool } = pg;

export interface UsageTotals {
  /** Every call, gap rows included (their `calls`). */
  calls: number;
  /** Answered calls whose provider reported no usage. */
  unknownCalls: number;
  /** Calls that failed. */
  errorCalls: number;
  /** Calls lost before they reached the ledger. */
  droppedCalls: number;
  /** Calls with known usage but no price for their model. */
  unpricedCalls: number;
  inputFresh: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  /** The mission budget's unit. */
  billable: number;
  /** Estimated, from the calls that have a price. */
  costUsd: number;
}

export interface UsageByRole extends UsageTotals {
  role: string;
  models: string[];
}

export interface UsageByItem {
  itemId: string;
  title: string;
  status: string;
  attempts: number;
  calls: number;
  billable: number;
  costUsd: number;
}

export interface UsageOutcome {
  itemsDone: number;
  billableOnDone: number;
  billableOnOther: number;
  /** Mission-level work no item owns: the survey, planning, the done-judgement. */
  billableShared: number;
  /** Everything spent divided by what got done — waste and shared work included. */
  billablePerDoneItem: number | null;
  costPerDoneItemUsd: number | null;
}

export interface UsageSummary {
  totals: UsageTotals;
  byRole: UsageByRole[];
  /** Empty for an interactive run. */
  byItem: UsageByItem[];
  /** Null for an interactive run. */
  outcome: UsageOutcome | null;
  /** missions.spent_tokens — what the budget counted. Null for an interactive run. */
  budgetCounted: number | null;
  /** False while some calls are unknown, dropped or unpriced — the price is then a minimum. */
  costComplete: boolean;
  /** ISO time of the first measured call; null when nothing is measured yet. */
  firstCallAt: string | null;
  priceTableVersion: string;
}

const ROLE_TOTALS = `
  SELECT role,
    COALESCE(SUM(calls), 0)::float8 AS calls,
    COALESCE(SUM(calls) FILTER (WHERE status = 'ok' AND NOT usage_known), 0)::float8 AS unknown_calls,
    COALESCE(SUM(calls) FILTER (WHERE status = 'error'), 0)::float8 AS error_calls,
    COALESCE(SUM(calls) FILTER (WHERE status = 'dropped'), 0)::float8 AS dropped_calls,
    COALESCE(SUM(calls) FILTER (WHERE usage_known AND cost_usd IS NULL), 0)::float8 AS unpriced_calls,
    COALESCE(SUM(input_fresh), 0)::float8 AS input_fresh,
    COALESCE(SUM(cache_write), 0)::float8 AS cache_write,
    COALESCE(SUM(cache_read), 0)::float8 AS cache_read,
    COALESCE(SUM(output), 0)::float8 AS output,
    COALESCE(SUM(billable), 0)::float8 AS billable,
    COALESCE(SUM(cost_usd), 0)::float8 AS cost_usd,
    COALESCE(array_agg(DISTINCT model) FILTER (WHERE model IS NOT NULL), '{}') AS models
  FROM llm_usage`;

const ITEM_TOTALS = `
  SELECT bi.id AS item_id, bi.title, bi.status,
    COUNT(DISTINCT u.attempt_id)::float8 AS attempts,
    COALESCE(SUM(u.calls), 0)::float8 AS calls,
    COALESCE(SUM(u.billable), 0)::float8 AS billable,
    COALESCE(SUM(u.cost_usd), 0)::float8 AS cost_usd
  FROM backlog_items bi
  LEFT JOIN llm_usage u ON u.item_id = bi.id
  WHERE bi.mission_id = $1
  GROUP BY bi.id, bi.title, bi.status
  ORDER BY billable DESC, bi.title`;

type Row = Record<string, unknown>;
const num = (value: unknown): number => Number(value ?? 0);
const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);
const round6 = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;

function toRole(row: Row): UsageByRole {
  return {
    role: String(row.role),
    models: (row.models as string[] | null) ?? [],
    calls: num(row.calls),
    unknownCalls: num(row.unknown_calls),
    errorCalls: num(row.error_calls),
    droppedCalls: num(row.dropped_calls),
    unpricedCalls: num(row.unpriced_calls),
    inputFresh: num(row.input_fresh),
    cacheWrite: num(row.cache_write),
    cacheRead: num(row.cache_read),
    output: num(row.output),
    billable: num(row.billable),
    costUsd: round6(num(row.cost_usd)),
  };
}

function totalsOf(roles: UsageByRole[]): UsageTotals {
  const add = (pick: (r: UsageByRole) => number) => sum(roles.map(pick));
  return {
    calls: add((r) => r.calls),
    unknownCalls: add((r) => r.unknownCalls),
    errorCalls: add((r) => r.errorCalls),
    droppedCalls: add((r) => r.droppedCalls),
    unpricedCalls: add((r) => r.unpricedCalls),
    inputFresh: add((r) => r.inputFresh),
    cacheWrite: add((r) => r.cacheWrite),
    cacheRead: add((r) => r.cacheRead),
    output: add((r) => r.output),
    billable: add((r) => r.billable),
    costUsd: round6(add((r) => r.costUsd)),
  };
}

export class UsageLedgerService implements UsageSink {
  private readonly pool: pg.Pool;

  constructor(opts: { connectionString: string }) {
    this.pool = new Pool({ connectionString: opts.connectionString });
  }

  /** Idempotent schema. Run after BacklogService.setup() — rows reference missions and backlog_items. */
  async setup(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS llm_usage (
        call_id      uuid PRIMARY KEY,
        at           timestamptz NOT NULL DEFAULT now(),
        mission_id   uuid REFERENCES missions(id) ON DELETE CASCADE,
        item_id      uuid REFERENCES backlog_items(id) ON DELETE CASCADE,
        attempt_id   uuid,
        task_id      uuid,
        role         text NOT NULL,
        provider     text,
        model        text,
        status       text NOT NULL DEFAULT 'ok',
        calls        integer NOT NULL DEFAULT 1,
        usage_known  boolean NOT NULL,
        input_fresh  bigint,
        cache_write  bigint,
        cache_read   bigint,
        output       bigint,
        billable     bigint,
        cost_usd     numeric(14, 6),
        latency_ms   integer
      )`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS llm_usage_mission_idx ON llm_usage (mission_id)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS llm_usage_item_idx ON llm_usage (item_id)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS llm_usage_task_idx ON llm_usage (task_id)`);
  }

  async insert(row: UsageRow): Promise<UsageInsertResult> {
    try {
      const result = await this.pool.query(
        `INSERT INTO llm_usage (
           call_id, at, mission_id, item_id, attempt_id, task_id, role, provider, model, status,
           calls, usage_known, input_fresh, cache_write, cache_read, output, billable, cost_usd, latency_ms
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         ON CONFLICT (call_id) DO NOTHING`,
        [
          row.callId, row.at, row.missionId, row.itemId, row.attemptId, row.taskId, row.role,
          row.provider, row.model, row.status, row.calls, row.usageKnown, row.inputFresh,
          row.cacheWrite, row.cacheRead, row.output, row.billable, row.costUsd, row.latencyMs,
        ],
      );
      return result.rowCount === 1 ? "inserted" : "duplicate";
    } catch (err) {
      // A row that can never be stored: its mission or item is gone (23503), or a
      // value is malformed (22xxx). Anything else is a connection problem — rethrow,
      // and the recorder keeps the row and retries.
      const code = String((err as { code?: unknown }).code ?? "");
      if (code === "23503" || code.startsWith("22")) return "rejected";
      throw err;
    }
  }

  async missionSummary(missionId: string): Promise<UsageSummary> {
    const [roles, items, mission, first] = await Promise.all([
      this.pool.query(`${ROLE_TOTALS} WHERE mission_id = $1 GROUP BY role`, [missionId]),
      this.pool.query(ITEM_TOTALS, [missionId]),
      this.pool.query(`SELECT spent_tokens FROM missions WHERE id = $1`, [missionId]),
      this.pool.query(`SELECT min(at) AS first_at FROM llm_usage WHERE mission_id = $1`, [missionId]),
    ]);
    const byRole = roles.rows.map(toRole).sort((a, b) => b.billable - a.billable);
    const totals = totalsOf(byRole);
    const byItem: UsageByItem[] = items.rows.map((row: Row) => ({
      itemId: String(row.item_id),
      title: String(row.title),
      status: String(row.status),
      attempts: num(row.attempts),
      calls: num(row.calls),
      billable: num(row.billable),
      costUsd: round6(num(row.cost_usd)),
    }));
    const done = byItem.filter((item) => item.status === "done");
    const billableOnDone = sum(done.map((item) => item.billable));
    const billableOnOther = sum(byItem.filter((item) => item.status !== "done").map((item) => item.billable));
    return {
      totals,
      byRole,
      byItem,
      outcome: {
        itemsDone: done.length,
        billableOnDone,
        billableOnOther,
        billableShared: totals.billable - billableOnDone - billableOnOther,
        billablePerDoneItem: done.length > 0 ? Math.round(totals.billable / done.length) : null,
        costPerDoneItemUsd: done.length > 0 ? round6(totals.costUsd / done.length) : null,
      },
      budgetCounted: mission.rows[0] ? num((mission.rows[0] as Row).spent_tokens) : null,
      costComplete: totals.unknownCalls + totals.droppedCalls + totals.unpricedCalls === 0,
      firstCallAt: toIso((first.rows[0] as Row | undefined)?.first_at),
      priceTableVersion: PRICE_TABLE_VERSION,
    };
  }

  async taskSummary(taskId: string): Promise<UsageSummary> {
    const [roles, first] = await Promise.all([
      this.pool.query(`${ROLE_TOTALS} WHERE task_id = $1 GROUP BY role`, [taskId]),
      this.pool.query(`SELECT min(at) AS first_at FROM llm_usage WHERE task_id = $1`, [taskId]),
    ]);
    const byRole = roles.rows.map(toRole).sort((a, b) => b.billable - a.billable);
    const totals = totalsOf(byRole);
    return {
      totals,
      byRole,
      byItem: [],
      outcome: null,
      budgetCounted: null,
      costComplete: totals.unknownCalls + totals.droppedCalls + totals.unpricedCalls === 0,
      firstCallAt: toIso((first.rows[0] as Row | undefined)?.first_at),
      priceTableVersion: PRICE_TABLE_VERSION,
    };
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}

function toIso(value: unknown): string | null {
  return value instanceof Date ? value.toISOString() : null;
}
```

The `import pg from "pg"` / `const { Pool } = pg` / `pg.Pool` form is the same one `backlog.ts` uses.

In `packages/shared/src/index.ts`, add at the end:

```ts
export {
  UsageLedgerService,
  type UsageSummary,
  type UsageTotals,
  type UsageByRole,
  type UsageByItem,
  type UsageOutcome,
} from "./usageLedger.js";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @arzonic/agent-shared exec tsx verify-usage-ledger.ts`
Expected: all `ok: …`, ending with `Usage ledger ✓`.

Check the table by hand:
`docker exec agent-engine-pg psql -U agent -d agent_engine -c "\d llm_usage"`
Expected: the 19 columns above, `llm_usage_pkey` on `call_id`, and the FKs to `missions` and `backlog_items`.

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm --filter @arzonic/agent-shared typecheck`
Expected: exits 0.

```bash
git add packages/shared/src/usageLedger.ts packages/shared/src/index.ts packages/shared/verify-usage-ledger.ts
git commit -m "$(cat <<'EOF'
feat(usage): the llm_usage ledger and the summaries the dashboard needs

UsageLedgerService stores one row per model call (call_id is the
primary key, so a re-sent row is a duplicate, not a second count) and
refuses — rather than throws on — a row whose mission is gone. Its
missionSummary() answers "what did a finished item cost, and why":
per role, per item with its attempts, and per finished item including
waste and shared work, next to the budget's own count. Unknown,
dropped and unpriced calls are reported, never folded into zeros.
taskSummary() covers interactive runs.

Verified: verify-usage-ledger.ts against the local Postgres.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Wire the recorder into the API and the mission worker

**Files:**
- Create: `apps/api/src/usage.provider.ts`
- Modify: `apps/api/src/tokens.ts`, `apps/api/src/app.module.ts`
- Modify: `apps/api/src/runs/runs.service.ts`, `apps/api/src/runs/runs.controller.ts`
- Modify: `apps/api/src/missions/missions.service.ts`, `apps/api/src/missions/missions.controller.ts`
- Modify: `apps/api/src/mission-worker.ts`
- Modify: `apps/api/smoke.ts` (it builds its own module around `RunsService`, which now injects `USAGE`)
- Modify: `packages/client/src/types.ts` (the API returns these types)

**Interfaces:**
- Consumes: `UsageLedgerService`, `createUsageRecorder`, `UsageSummary` (Tasks 6–7); `usageMetadata` (Task 1); every `callbacks`/`usageContext` option from Tasks 2 and 4.
- Produces: `GET /missions/:id/usage` and `GET /runs/:id/usage` → `ApiUsageSummary`; DI token `USAGE` (`UsageHandle | null`); `createUsage(env, label?)`.

- [ ] **Step 1: Add the client types**

Append to `packages/client/src/types.ts`:

```ts
// ── Usage ledger (GET /missions/:id/usage, GET /runs/:id/usage) ──

/** Token and price totals for a set of model calls. Unknown usage is never counted as 0 — see the *Calls counters. */
export interface ApiUsageTotals {
  calls: number;
  /** Answered calls whose provider reported no usage. */
  unknownCalls: number;
  errorCalls: number;
  /** Calls lost before they reached the ledger. */
  droppedCalls: number;
  /** Calls with known usage but no price for their model. */
  unpricedCalls: number;
  inputFresh: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  /** The mission budget's unit (cache-weighted tokens). */
  billable: number;
  /** Estimated USD, from the calls that have a price. */
  costUsd: number;
}

export interface ApiUsageByRole extends ApiUsageTotals {
  role: string;
  models: string[];
}

export interface ApiUsageByItem {
  itemId: string;
  title: string;
  status: string;
  attempts: number;
  calls: number;
  billable: number;
  costUsd: number;
}

export interface ApiUsageOutcome {
  itemsDone: number;
  billableOnDone: number;
  billableOnOther: number;
  /** Mission-level work no item owns: survey, planning, the done-judgement. */
  billableShared: number;
  /** Everything spent divided by what got done — waste and shared work included. */
  billablePerDoneItem: number | null;
  costPerDoneItemUsd: number | null;
}

export interface ApiUsageSummary {
  totals: ApiUsageTotals;
  byRole: ApiUsageByRole[];
  byItem: ApiUsageByItem[];
  outcome: ApiUsageOutcome | null;
  /** What the mission budget counted (missions.spent_tokens). */
  budgetCounted: number | null;
  /** False while some calls are unknown, dropped or unpriced — the price is then a minimum. */
  costComplete: boolean;
  firstCallAt: string | null;
  priceTableVersion: string;
}
```

- [ ] **Step 2: Add the provider and the DI token**

Append to `apps/api/src/tokens.ts`:

```ts
/** The usage ledger + its recorder (UsageHandle | null). */
export const USAGE = "USAGE" as const;
```

Create `apps/api/src/usage.provider.ts`:

```ts
import { createUsageRecorder, UsageLedgerService, type UsageRecorder } from "@arzonic/agent-shared";
import type { ApiEnv } from "./env.js";

/** The usage ledger (llm_usage) and the recorder that feeds it. */
export interface UsageHandle {
  ledger: UsageLedgerService;
  recorder: UsageRecorder;
}

/**
 * Builds the usage ledger and its recorder. Run AFTER createBacklog: the table
 * references missions and backlog_items. Degrades to null — measuring must never
 * stop the app from booting — when there is no database or the schema can't be
 * created. Mirrors createBacklog/createMemory's "degrade gracefully" policy.
 */
export async function createUsage(env: ApiEnv, label = "agent-api"): Promise<UsageHandle | null> {
  if (!env.SUPABASE_DB_URL) {
    console.warn(`[${label}] SUPABASE_DB_URL missing — model usage is not measured.`);
    return null;
  }
  const ledger = new UsageLedgerService({ connectionString: env.SUPABASE_DB_URL });
  try {
    await ledger.setup();
  } catch (err) {
    console.warn(
      `[${label}] usage ledger disabled — schema setup failed:`,
      err instanceof Error ? err.message : err,
    );
    await ledger.end().catch(() => undefined);
    return null;
  }
  const recorder = createUsageRecorder(ledger, { log: (message) => console.warn(`[${label}] ${message}`) });
  return { ledger, recorder };
}
```

In `apps/api/src/app.module.ts`:
1. Add `import { createUsage } from "./usage.provider.js";` next to the other provider imports.
2. Add `USAGE` to the `./tokens.js` import list.
3. Add this provider after the `SETTINGS` provider:

```ts
    {
      provide: USAGE,
      // After BACKLOG: llm_usage references missions and backlog_items.
      useFactory: (env: ApiEnv) => createUsage(env),
      inject: [ENV, BACKLOG],
    },
```

Nest will pass the resolved backlog as a second argument. The factory ignores it; the `inject` entry is there only to order the setup.

- [ ] **Step 3: Measure interactive runs and expose `GET /runs/:id/usage`**

In `apps/api/src/runs/runs.service.ts`:
1. Imports: add `USAGE` to the `../tokens.js` import; add `import type { UsageHandle } from "../usage.provider.js";`; add `usageMetadata` to the existing `@arzonic/agent-core` import list; add `type UsageSummary` to the existing `@arzonic/agent-shared` import list. `BadRequestException` is already imported from `@nestjs/common`.
2. Add the constructor parameter after `MEMORY`:

```ts
    @Inject(USAGE) private readonly usageHandle: UsageHandle | null,
```

3. Replace

```ts
  private config(runId: string, signal?: AbortSignal) {
    return { configurable: { thread_id: runId }, signal };
  }
```

with

```ts
  private config(runId: string, signal?: AbortSignal) {
    return {
      configurable: { thread_id: runId },
      signal,
      // Every model call in the run lands in the usage ledger, tagged with the run.
      ...(this.usageHandle
        ? { callbacks: [this.usageHandle.recorder.handler], metadata: usageMetadata({ taskId: runId }) }
        : {}),
    };
  }

  /** What one run's model calls cost, per role — from the usage ledger. */
  async usage(runId: string): Promise<UsageSummary> {
    if (!this.usageHandle) {
      throw new BadRequestException("Usage needs a database — set SUPABASE_DB_URL.");
    }
    return this.usageHandle.ledger.taskSummary(runId);
  }
```

4. In `onModuleDestroy`, before `await this.checkpointer.close();`, add:

```ts
    // Write the last buffered calls before the process goes.
    await this.usageHandle?.recorder.close();
```

In `apps/api/src/runs/runs.controller.ts`, add `ApiUsageSummary` to the `@arzonic/agent-client` type import and add this handler directly after `getRun`:

```ts
  /** What this run's model calls cost, per role — from the usage ledger. */
  @Get(":id/usage")
  usage(@Param("id") id: string): Promise<ApiUsageSummary> {
    return this.runs.usage(id);
  }
```

- [ ] **Step 4: Expose `GET /missions/:id/usage`**

In `apps/api/src/missions/missions.service.ts`:
1. Add `USAGE` to the `../tokens.js` import, `import type { UsageHandle } from "../usage.provider.js";`, and `type UsageSummary` to the `@arzonic/agent-shared` type import.
2. Add the constructor parameter last:

```ts
    @Inject(USAGE) private readonly usageHandle: UsageHandle | null,
```

3. Add this method after `itemDiff`:

```ts
  /** What a mission's model calls cost — per role, per item and per finished item. */
  async usage(missionId: string): Promise<UsageSummary> {
    const backlog = this.require();
    if (!(await backlog.getMission(missionId))) {
      throw new NotFoundException(`No mission ${missionId}`);
    }
    if (!this.usageHandle) {
      throw new BadRequestException("Usage needs a database — set SUPABASE_DB_URL.");
    }
    return this.usageHandle.ledger.missionSummary(missionId);
  }
```

In `apps/api/src/missions/missions.controller.ts`, add `ApiUsageSummary` to the `@arzonic/agent-client` type import and add this handler after `itemDiff`:

```ts
  /** What this mission's model calls cost — the dashboard's "Forbrug pr. rolle". */
  @Get(":id/usage")
  usage(@Param("id") id: string): Promise<ApiUsageSummary> {
    return this.missions.usage(id);
  }
```

- [ ] **Step 5: Measure every call the mission worker makes**

In `apps/api/src/mission-worker.ts`:
1. Add `import { createUsage } from "./usage.provider.js";` next to `import { createMemory } from "./memory.provider.js";`.
2. Directly after `const memory = await createMemory(env);`, add:

```ts
  // Every model call this worker makes lands in the usage ledger (llm_usage):
  // one row per call, tagged with mission, item, attempt and role. After the
  // backlog, whose tables the ledger references. Null ⇒ not measured (logged).
  const usage = await createUsage(env, "mission-worker");
  const usageCallbacks = usage ? [usage.recorder.handler] : undefined;
```

3. In the `surveyRepo({ … })` call, add after `llmCallTimeoutMs: env.LLM_CALL_TIMEOUT_MS,`:

```ts
          callbacks: usageCallbacks,
          usageContext: { missionId: mission.id },
```

4. Add `callbacks: usageCallbacks,` as the last option of each of these calls: `makeReplanner(…, { backlogTitles … })`, `makeDecomposer(…, { allowedChecks … })`, `makeRubricAssessor(…, { evidence … })` and `makeTestAuthor(…, { repo … })`.
5. In `createWorktreeWorkRunner({ … })`, add after `baseRef: missionBranch,`:

```ts
        callbacks: usageCallbacks,
        usageContext: { missionId: mission.id },
```

6. In the shutdown sequence, directly before `await mcp.close();`, add:

```ts
  // Write the last buffered calls before the pool goes away.
  if (usage) {
    await usage.recorder.close();
    await usage.ledger.end();
  }
```

- [ ] **Step 6: Typecheck the whole repo**

Run: `pnpm typecheck`
Expected: every package passes. Turbo builds core, shared and client first.

- [ ] **Step 7: Keep the API smoke test booting**

`apps/api/smoke.ts` builds its own Nest module around `RunsService`, so it has to provide the new dependency.
1. Add `USAGE` to its import `import { CHECKPOINTER, ENV, MEMORY, MODEL, ROLE_MODELS } from "./dist/tokens.js";`.
2. Add this line next to `{ provide: MEMORY, useValue: null },`:

```ts
      { provide: USAGE, useValue: null },
```

Run: `pnpm --filter @arzonic/agent-api build && pnpm --filter @arzonic/agent-api run smoke`
Expected: every smoke assertion passes. The 2026-09-14 audit (F17) notes that the process can hang on shutdown after the last assertion. If it hangs there, stop it with Ctrl-C and record that in the commit message.

- [ ] **Step 8: Boot smoke against the local database**

With Postgres up (Task 7 Step 1), run in a separate terminal: `pnpm api`
Expected: the API boots with no `usage ledger disabled` warning.

Then, with `KEY` set to `AGENT_API_KEY` from `.env`:
```bash
curl -s -H "Authorization: Bearer $KEY" localhost:8787/missions | head -c 300
```
Pick any mission id from the output, then run:
```bash
curl -s -H "Authorization: Bearer $KEY" localhost:8787/missions/<mission-id>/usage
```
Expected: JSON with `"totals":{"calls":0,…}`, `"byItem":[…]` (that mission's items) and `"budgetCounted":<its spent_tokens>`. An old mission has no measured calls. If there are no missions, `GET /missions/00000000-0000-4000-8000-000000000000/usage` must return 404, not 500.

Stop the API.

- [ ] **Step 9: Commit**

```bash
git add packages/client/src/types.ts apps/api/src/tokens.ts apps/api/src/usage.provider.ts apps/api/src/app.module.ts apps/api/src/runs/runs.service.ts apps/api/src/runs/runs.controller.ts apps/api/src/missions/missions.service.ts apps/api/src/missions/missions.controller.ts apps/api/src/mission-worker.ts apps/api/smoke.ts
git commit -m "$(cat <<'EOF'
feat(usage): measure every model call the API and the worker make

One usage recorder per process. The worker hands it to the item runner
(with the mission as context) and to the survey, decomposer, replanner,
rubric assessor and test author; the API attaches it to every
interactive run with the run id. Both flush on shutdown. The ledger is
created after the backlog it references and degrades to "not measured"
instead of blocking boot.

New: GET /missions/:id/usage and GET /runs/:id/usage (ApiUsageSummary).
The budget is untouched.

Verified: pnpm typecheck; the API smoke test; booted against the local
Postgres and read a mission's usage summary over HTTP.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: The "Forbrug pr. rolle" panel

**Files:**
- Create: `apps/web/app/api/missions/[id]/usage/route.ts`
- Create: `apps/web/app/components/MissionUsagePanel.tsx`
- Modify: `apps/web/app/missions/[id]/page.tsx`

**Interfaces:**
- Consumes: `ApiUsageSummary` (Task 8); `GET /missions/:id/usage` (Task 8).
- Produces: `MissionUsagePanel({ missionId: string; active: boolean })`.

- [ ] **Step 1: Add the proxy route**

Create `apps/web/app/api/missions/[id]/usage/route.ts`:

```ts
import { agentFetch } from "../../../../lib/agent";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const res = await agentFetch(`/missions/${encodeURIComponent(id)}/usage`);
  return new Response(await res.text(), {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}
```

- [ ] **Step 2: Write the panel**

Create `apps/web/app/components/MissionUsagePanel.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { LuActivity, LuTriangleAlert } from "react-icons/lu";
import type { ApiUsageSummary } from "@arzonic/agent-client";

/** Danish names for the roles — the team picker's names where they overlap. */
const ROLE_LABEL: Record<string, string> = {
  survey: "Kortlægning",
  decompose: "Planlægger",
  implementer: "Udvikler",
  missionCritic: "Kritiker",
  tester: "Tester",
  replan: "Koordinator",
  rubricAssessor: "Done-dom",
  router: "Router",
  architect: "Arkitekt",
  proposeCriteria: "Kriterieforslag",
  builder: "Builder",
  critic: "Kritiker",
  worker: "Worker",
  lead: "Lead",
  analyst: "Analytiker",
  unrecorded: "Ikke gemt",
  unknown: "Ukendt rolle",
};

const STATUS_LABEL: Record<string, string> = {
  done: "færdig",
  failed: "fejlet",
  blocked_needs_human: "afventer dig",
  in_progress: "i gang",
  todo: "i kø",
};

const fmt = (n: number) => n.toLocaleString("da-DK");
const usd = (n: number) => `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`;

function Heading({ total }: { total?: string }) {
  return (
    <h2 className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-[0.28em] text-dim">
      <LuActivity className="h-3.5 w-3.5" />
      Forbrug pr. rolle
      {total && <span className="ml-auto font-mono normal-case tracking-normal text-fg/70">{total}</span>}
    </h2>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5 rounded-field border border-line bg-elev px-2.5 py-1">
      <span className="font-mono font-semibold text-fg/90">{value}</span>
      {sub && <span className="font-mono text-dim">{sub}</span>}
      <span className="text-dim">{label}</span>
    </span>
  );
}

/**
 * What the mission's model calls cost: per role, the most expensive items, and
 * per finished item — waste and shared work included. Reads the usage ledger;
 * refreshes every 15 s while the mission runs.
 */
export function MissionUsagePanel({ missionId, active }: { missionId: string; active: boolean }) {
  const [data, setData] = useState<ApiUsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`/api/missions/${missionId}/usage`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as ApiUsageSummary;
        if (alive) {
          setData(body);
          setError(null);
        }
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    const timer = active ? setInterval(() => void load(), 15_000) : null;
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
  }, [missionId, active]);

  if (!data) {
    if (!error) return null;
    return (
      <section className="mt-6">
        <Heading />
        <p className="text-xs text-error">Forbruget kunne ikke hentes ({error}).</p>
      </section>
    );
  }

  const { totals, byRole, byItem, outcome } = data;
  if (totals.calls === 0) {
    return (
      <section className="mt-6">
        <Heading />
        <p className="rounded-box border border-line bg-panel px-4 py-3 text-xs text-dim">
          Ingen målte modelkald endnu. Målingen tæller kun kald, efter den blev slået til, så ældre missioner står tomme.
        </p>
      </section>
    );
  }

  const approx = data.costComplete ? "≈" : "≥";
  const top = Math.max(1, ...byRole.map((r) => r.billable));
  const expensive = byItem.filter((i) => i.calls > 0).slice(0, 5);
  const gaps = [
    totals.unknownCalls > 0 ? `${fmt(totals.unknownCalls)} kald uden forbrugstal` : null,
    totals.droppedCalls > 0 ? `${fmt(totals.droppedCalls)} kald kunne ikke gemmes` : null,
    totals.unpricedCalls > 0 ? `${fmt(totals.unpricedCalls)} kald uden kendt pris` : null,
  ].filter((g): g is string => g !== null);
  const counted = data.budgetCounted;

  return (
    <section className="mt-6">
      <Heading total={`${approx} ${usd(totals.costUsd)}`} />
      <div className="rise rounded-box border border-line bg-panel px-4 py-3">
        {outcome && (
          <div className="mb-3 flex flex-wrap gap-2 text-xs">
            <Stat
              label="pr. færdigt item"
              value={outcome.billablePerDoneItem === null ? "–" : `${fmt(outcome.billablePerDoneItem)} tokens`}
              sub={outcome.costPerDoneItemUsd === null ? undefined : `${approx} ${usd(outcome.costPerDoneItemUsd)}`}
            />
            <Stat
              label="på items, der ikke blev færdige"
              value={`${fmt(outcome.billableOnOther)} tokens`}
              sub={totals.billable > 0 ? `${Math.round((outcome.billableOnOther / totals.billable) * 100)} %` : undefined}
            />
            <Stat label="fælles (kortlægning, plan, done-dom)" value={`${fmt(outcome.billableShared)} tokens`} />
          </div>
        )}

        <table className="w-full text-xs">
          <thead className="text-left text-[10px] uppercase tracking-[0.2em] text-dim">
            <tr>
              <th className="py-1 font-normal">Rolle</th>
              <th className="py-1 text-right font-normal">Kald</th>
              <th className="py-1 text-right font-normal">Tokens</th>
              <th className="w-1/4 py-1 font-normal">
                <span className="sr-only">Andel</span>
              </th>
              <th className="py-1 text-right font-normal">Pris</th>
            </tr>
          </thead>
          <tbody>
            {byRole.map((r) => (
              <tr key={r.role} className="border-t border-line/60">
                <td className="py-1.5 pr-2 text-fg/90">
                  {ROLE_LABEL[r.role] ?? r.role}
                  {r.models.length > 0 && (
                    <span className="ml-1.5 font-mono text-[10px] text-dim">{r.models.join(", ")}</span>
                  )}
                </td>
                <td className="py-1.5 text-right font-mono tabular-nums text-fg/80">{fmt(r.calls)}</td>
                <td className="py-1.5 text-right font-mono tabular-nums text-fg/80">{fmt(r.billable)}</td>
                <td className="px-3 py-1.5">
                  <div className="h-1.5 overflow-hidden rounded-full bg-elev">
                    <div className="h-full rounded-full bg-builder" style={{ width: `${(r.billable / top) * 100}%` }} />
                  </div>
                </td>
                <td className="py-1.5 text-right font-mono tabular-nums text-dim">
                  {r.unpricedCalls > 0 || r.unknownCalls > 0 ? "?" : usd(r.costUsd)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {expensive.length > 0 && (
          <div className="mt-3">
            <p className="mb-1 text-[10px] uppercase tracking-[0.2em] text-dim">Dyreste items</p>
            <ul className="space-y-1 text-xs">
              {expensive.map((i) => (
                <li key={i.itemId} className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate text-fg/80">{i.title}</span>
                  <span className="shrink-0 font-mono tabular-nums text-dim">
                    {STATUS_LABEL[i.status] ?? i.status} · {i.attempts} forsøg · {fmt(i.billable)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {counted !== null && (
          <p className="mt-3 text-[11px] text-dim">
            Budgettet har talt {fmt(counted)} tokens · målt {fmt(totals.billable)}.
            {totals.billable > counted && " Forskellen er kald, budgettet ikke tæller med, fx kortlægningen og løkker, der fejlede."}
            {totals.billable < counted && " Budgettet har talt mere, end vi har målt — typisk fordi missionen startede, før målingen blev slået til."}
          </p>
        )}
        {gaps.length > 0 && (
          <p className="mt-1 flex items-start gap-1.5 text-[11px] text-warning">
            <LuTriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
            {gaps.join(" · ")}. Tallene er derfor et minimum.
          </p>
        )}
      </div>
    </section>
  );
}
```

- [ ] **Step 3: Render the panel on the mission page**

In `apps/web/app/missions/[id]/page.tsx`:
1. Add `import { MissionUsagePanel } from "../../components/MissionUsagePanel";` below the `MissionLiveFeed` import.
2. Directly after the closing `/>` of `<MissionLiveFeed … />` and before `{/* backlog board */}`, add:

```tsx
        {/* what the mission's model calls cost, per role and per finished item */}
        <MissionUsagePanel missionId={id} active={mission.status === "running"} />
```

- [ ] **Step 4: Typecheck and build the web app**

Run: `pnpm typecheck && pnpm --filter @arzonic/agent-web build`
Expected: both pass.

- [ ] **Step 5: Look at it**

Start the stack (`pnpm dev`, plus Postgres from Task 7). Open `http://localhost:3400/missions/<a mission id>`. Follow the repo's Playwright note: use channel `"chrome"` against localhost, because the bundled headless Chromium does not hydrate the app. Take one screenshot in the default theme.
Expected:
- An unmeasured mission shows the "Ingen målte modelkald endnu" note, under the live feed and above the board.
- After Task 10's live run, the mission shows the role table, the three stats and the budget line.

Fix only what is visibly broken: clipped text, overflow at 400 px width, or a colour that doesn't read.

- [ ] **Step 6: Commit**

```bash
git add "apps/web/app/api/missions/[id]/usage/route.ts" apps/web/app/components/MissionUsagePanel.tsx "apps/web/app/missions/[id]/page.tsx"
git commit -m "$(cat <<'EOF'
feat(web): "Forbrug pr. rolle" — what a mission's model calls cost

A panel under the live feed shows, from the usage ledger, spend per
role (calls, tokens, share, estimated price), the most expensive items
with their attempts, and three numbers that answer "what does a
finished item cost": per finished item (waste and shared work
included), spend on items that never finished, and shared work.

It puts the budget's own count next to the measured one, and says
plainly when calls are unknown, unstored or unpriced, so the price
reads as a minimum. Refreshes every 15 s while the mission runs.

Verified: pnpm typecheck; web build; checked in the browser.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Full verification, a live run and the record

**Files:**
- Modify: `docs/BACKLOG.md`
- Memory: `/Users/marcmoller/.claude/projects/-Users-marcmoller-Documents-GitHub-agent-engine/memory/usage-ledger.md` and its line in `MEMORY.md`

- [ ] **Step 1: Run every hermetic verify script**

Run:
```bash
pnpm --filter @arzonic/agent-core build
for f in packages/core/verify-*.ts; do case "$f" in *verify-decompose-live.ts|*verify-usage-fakes.ts) continue;; esac; echo "== $f"; pnpm --filter @arzonic/agent-core exec tsx "$(basename "$f")" > /tmp/v.log 2>&1 || { tail -20 /tmp/v.log; echo "FAILED: $f"; }; done
for f in packages/shared/verify-*.ts; do case "$f" in *-live.ts|*verify-memory.ts|*verify-usage-ledger.ts) continue;; esac; echo "== $f"; pnpm --filter @arzonic/agent-shared exec tsx "$(basename "$f")" > /tmp/v.log 2>&1 || { tail -20 /tmp/v.log; echo "FAILED: $f"; }; done
```
Expected: no `FAILED:` line. Any failure must be fixed before going on. A failure in a script this plan didn't touch also counts: report it and stop.

Then run the database proof: `pnpm --filter @arzonic/agent-shared exec tsx verify-usage-ledger.ts`. Expected: `Usage ledger ✓`.

- [ ] **Step 2: Live run — ask the user first**

A live run spends real model tokens on the configured provider. A small interactive run costs cents, but ask in chat before starting it, and do not start it without a yes.

With a yes, and the stack running (`docker compose up -d`, `pnpm dev`, and `pnpm --filter @arzonic/agent-api run worker:dev` for missions):
```bash
curl -s -X POST localhost:8787/runs -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"task":"Skriv en haiku om tokens"}'
```
Wait for the run to finish. Then read `GET /runs/<runId>/usage`, and check the database:
```bash
docker exec agent-engine-pg psql -U agent -d agent_engine -c "SELECT role, model, usage_known, input_fresh, cache_read, output, billable, cost_usd FROM llm_usage ORDER BY at DESC LIMIT 10"
```
Expected: a router row and builder/critic rows, all with `usage_known = t`, the model the provider actually served, and a price when that model is in the table.

If the user also wants a mission checked, start a tiny one on a scratch repo through the UI. Its panel should then show the roles, the items, and the budget line next to the measured total.

- [ ] **Step 3: Record it in the backlog**

In `docs/BACKLOG.md`, add an entry under the "Autonome missioner" epic, following the style of the surrounding entries:

```markdown
- [x] **Fase 0, etape A: token-ledger (2026-10-07).** Hvert modelkald er én række i `llm_usage` med mission, item, forsøg, rolle, model, rå tokenklasser, betalte tokens og estimeret pris. `GET /missions/:id/usage` og panelet "Forbrug pr. rolle" viser forbrug pr. rolle, de dyreste items og forbrug pr. færdigt item. Budgettet er uændret. Spec: `docs/superpowers/specs/2026-10-07-token-ledger-design.md`.
- [ ] **Fase 0, etape A2: budget fra ledgeren.** Budget og watcher læser fra `llm_usage`, så surveyen og fejlede løkker tæller med (lukker F08).
- [ ] **Etape B: entydigt "færdig".** Et item er færdigt, når:
  - de relevante checks består
  - acceptkriterierne er dokumenteret opfyldt
  - der ikke er uløste, blokerende reviewfund (criticen er kun rådgivende i dag)
  - den integrerede ændring består checks igen

  Det skal være på plads, før en billig model får indflydelse på afslutningen.
- [ ] **Fase 0, del 2: beslutningsport.** Én port i core, som Clef, Jev eller en lille sprogmodel kan stå bag. Den køres i skygge først. Undersøg især forkerte godkendelser, og aktivér gradvist, startende med routing.
```

Commit:
```bash
git add docs/BACKLOG.md
git commit -m "$(cat <<'EOF'
docs(backlog): the token ledger is in; budget-from-ledger and the decision port are next

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: Save the project memory**

Write `/Users/marcmoller/.claude/projects/-Users-marcmoller-Documents-GitHub-agent-engine/memory/usage-ledger.md`:

```markdown
---
name: usage-ledger
description: Every model call is a row in llm_usage (role, mission, item, attempt, model, tokens, price); how attribution works and its pitfalls.
metadata:
  type: project
---

Shipped 2026-10-07 (fase 0, etape A of the Jev/Clef assessment). `llm_usage` holds one row per model call; `GET /missions/:id/usage` and the "Forbrug pr. rolle" panel summarise it. The budget is still the old `spent_tokens` — the ledger only measures.

**Why:** we needed per-role cost before choosing models per role or putting a decision model (Clef/Jev) in front of the loops. The north-star number is spend per correctly finished item, waste included.

**How to apply:**
- Attribution rides on LangChain metadata (`ae_role`, `ae_mission_id`, `ae_item_id`, `ae_attempt_id`, `ae_task_id`). The recorder MUST be an inheritable callback on the outermost invoke. As a model constructor callback, the outer metadata never reaches nested calls.
- A new model call site needs `withUsage("<role>", config)`; a new component outside a graph needs a `callbacks` option. Otherwise its calls show up as `unknown`.
- Unknown usage, unknown price and lost calls are NULL / gap rows, never 0. A model missing from `packages/shared/src/pricing.ts` shows as "uden kendt pris".
- Next: budget from the ledger (closes F08), then the decision port. See [[mission-guardrail-gaps]] and [[per-role-models]].
```

Then add this line to `MEMORY.md`, under the existing entries:

```markdown
- [Usage ledger](usage-ledger.md) — 2026-10-07: every model call is a row in llm_usage; attribution via LangChain metadata; unknown ≠ 0.
```
