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
import { estimateCostUsd, type CacheTtl, type TokenCounts } from "./pricing.js";

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
  /** The prompt-cache TTL this process's calls write at (LLM_PROMPT_CACHE_TTL) — prices cache writes. Default "5m". */
  cacheTtl?: CacheTtl;
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
  cacheTtl: CacheTtl,
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
    costUsd: measured ? estimateCostUsd(model, measured.counts, cacheTtl) : null,
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
    private readonly cacheTtl: CacheTtl,
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
    this.record(callRow(runId, start, this.now(), "ok", this.cacheTtl, message, output.llmOutput));
  }

  override handleLLMError(_err: unknown, runId: string): void {
    const start = this.take(runId);
    if (!start) return;
    this.record(callRow(runId, start, this.now(), "error", this.cacheTtl));
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
  const cacheTtl = options.cacheTtl ?? "5m";
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
    handler: new UsageCallbackHandler(record, now, cacheTtl),
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
