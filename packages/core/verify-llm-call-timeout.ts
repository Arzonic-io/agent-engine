/**
 * HERMETIC verify for the LLM call timeout (Fase 3 of the stuck-run-stream
 * fix). No network — every model is a scripted fake — proves:
 *   • withLlmTimeout rejects a never-settling promise within its configured
 *     window, with a message that names the call and the timeout
 *   • withLlmTimeout passes a normally-resolving promise's value straight
 *     through, unmodified, so wrapping every node call adds no behavioral
 *     regression on the happy path
 *   • the wiring through a real node factory (not just the bare utility) is
 *     what actually protects a run: a plain-invoke node (builder) and a
 *     structured-output node (architect) both reject within their configured
 *     `llmCallTimeoutMs` when the underlying model call never settles —
 *     this is the exact failure mode that used to hang a run (or, on the
 *     decide()/"revise" path, the HTTP request itself) forever
 *
 * Run: pnpm --filter @arzonic/agent-core exec tsx verify-llm-call-timeout.ts
 */
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";
import { makeArchitectNode } from "./src/nodes/architect.js";
import { makeBuilderNode } from "./src/nodes/builder.js";
import { withLlmTimeout } from "./src/llmCallTimeout.js";
import type { GraphStateType } from "./src/state.js";

const ok = (c: boolean, m: string) => {
  if (!c) throw new Error(`FAIL: ${m}`);
  console.log(`ok: ${m}`);
};

/** A minimal but complete GraphState for driving a single node. */
function state(over: Partial<GraphStateType> = {}): GraphStateType {
  return {
    task: "Write a short answer",
    messages: [],
    draft: "",
    round: 0,
    verdict: null,
    status: "running",
    tokensUsed: 0,
    humanNotes: "",
    plan: [],
    currentStep: 0,
    stepResults: [],
    projectId: "",
    context: "",
    topology: "single",
    ...over,
  } as GraphStateType;
}

/** A plain-invoke model whose call NEVER settles — simulates a truly hung provider. */
function neverResolvingModel(): BaseChatModel {
  return { invoke: () => new Promise(() => {}) } as unknown as BaseChatModel;
}

/** A structured-output model whose call NEVER settles. */
function neverResolvingStructuredModel(): BaseChatModel {
  return {
    withStructuredOutput: () => ({ invoke: () => new Promise(() => {}) }),
  } as unknown as BaseChatModel;
}

/** A plain-invoke model that resolves immediately with a scripted draft. */
function fastModel(content: string, tokens = 5): BaseChatModel {
  return {
    invoke: async () =>
      new AIMessage({
        content,
        usage_metadata: { input_tokens: 1, output_tokens: tokens - 1, total_tokens: tokens },
      }),
  } as unknown as BaseChatModel;
}

const TEST_TIMEOUT_MS = 40;

// ── 1. withLlmTimeout in isolation ──
{
  const start = Date.now();
  let threw: Error | null = null;
  try {
    await withLlmTimeout(new Promise(() => {}), TEST_TIMEOUT_MS, "widget");
  } catch (err) {
    threw = err as Error;
  }
  const elapsed = Date.now() - start;
  ok(threw !== null, "a never-settling promise rejects instead of hanging forever");
  ok(
    threw!.message === `widget call timed out after ${TEST_TIMEOUT_MS}ms`,
    "the rejection names the call and the configured timeout",
  );
  ok(elapsed < TEST_TIMEOUT_MS * 5, "the rejection fires close to the configured window, not late");

  const value = await withLlmTimeout(Promise.resolve("real result"), TEST_TIMEOUT_MS, "widget");
  ok(value === "real result", "a normally-resolving promise's value passes through unmodified");
}

// ── 2. Wired into a plain-invoke node (builder) ──
{
  let threw = false;
  let message = "";
  try {
    await makeBuilderNode(neverResolvingModel(), TEST_TIMEOUT_MS)(state());
  } catch (err) {
    threw = true;
    message = err instanceof Error ? err.message : String(err);
  }
  ok(threw, "builder node rejects (rather than hanging) when the model never settles");
  ok(message.includes("builder") && message.includes(`${TEST_TIMEOUT_MS}ms`), "the error identifies the builder call + timeout");

  // Regression guard: a fast, normal call still works exactly as before.
  const draft = await makeBuilderNode(fastModel("hello world"), TEST_TIMEOUT_MS)(state());
  ok(draft.draft === "hello world", "a normal builder call is unaffected by the timeout wrapper");
  ok(draft.tokensUsed === 5, "token accounting is unaffected by the timeout wrapper");
}

// ── 3. Wired into a structured-output node (architect) ──
{
  let threw = false;
  let message = "";
  try {
    await makeArchitectNode(neverResolvingStructuredModel(), TEST_TIMEOUT_MS)(state());
  } catch (err) {
    threw = true;
    message = err instanceof Error ? err.message : String(err);
  }
  ok(threw, "architect node rejects (rather than hanging) when the structured call never settles");
  ok(message.includes("architect") && message.includes(`${TEST_TIMEOUT_MS}ms`), "the error identifies the architect call + timeout");
}

console.log("\n✅ verify-llm-call-timeout: all checks passed");
