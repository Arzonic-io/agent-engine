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

// ── 1b. The same call at the 1-hour cache TTL: cache writes cost more ──
{
  const sink = new MemorySink();
  const recorder = createUsageRecorder(sink, { flushIntervalMs: 60_000, log: quiet(), cacheTtl: "1h" });
  await call(new ChatCached({}), "implementer", recorder.handler);
  await recorder.flush();
  const row = [...sink.rows.values()][0];
  ok(row?.costUsd === 0.00468, "at the 1-hour cache TTL, writes are priced at 2x input ($0.00468)");
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
