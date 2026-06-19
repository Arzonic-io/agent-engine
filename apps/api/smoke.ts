/**
 * Throwaway smoke test for the API — boots the compiled Nest app with a stub
 * model and a shared MemorySaver (simulating the persistent checkpointer),
 * then exercises every endpoint over real HTTP via @arzonic/agent-client.
 * Run: pnpm --filter @arzonic/agent-api run smoke
 */
import "reflect-metadata";
import { Module, type INestApplication } from "@nestjs/common";
import { APP_GUARD, NestFactory } from "@nestjs/core";
import { AIMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { MemorySaver } from "@langchain/langgraph";
import { AgentClient, type RunEvent } from "@arzonic/agent-client";
import { ApiKeyGuard } from "./dist/auth/api-key.guard.js";
import { RunsController } from "./dist/runs/runs.controller.js";
import { RunsService } from "./dist/runs/runs.service.js";
import { CHECKPOINTER, ENV, MEMORY, MODEL, ROLE_MODELS } from "./dist/tokens.js";

const API_KEY = "smoke-test-key-0123456789abcdef";

const stubEnv = {
  LLM_PROVIDER: "mistral",
  MAX_ROUNDS: 3,
  RUN_TIMEOUT_MS: 30_000,
  RUN_TOKEN_BUDGET: undefined,
  AGENT_API_KEY: API_KEY,
  API_PORT: 0,
  API_CORS_ORIGINS: [],
};

function stubModel(passOnCall: number): BaseChatModel {
  let buildCalls = 0;
  let criticCalls = 0;
  const usage = { input_tokens: 10, output_tokens: 10, total_tokens: 20 };
  return {
    invoke: async () => {
      buildCalls++;
      return new AIMessage({ content: `draft v${buildCalls}`, usage_metadata: usage });
    },
    withStructuredOutput: () => ({
      invoke: async () => {
        criticCalls++;
        const pass = criticCalls >= passOnCall;
        return {
          raw: new AIMessage({ content: "", usage_metadata: usage }),
          parsed: {
            score: pass ? 95 : 40,
            criteria: ["correctness", "completeness", "matches-task", "edge-cases", "clarity"].map(
              (id) => ({ id, met: pass || id === "clarity", note: "stub" }),
            ),
            issues: pass ? [] : [`fix this (critic call ${criticCalls})`],
          },
        };
      },
    }),
  } as unknown as BaseChatModel;
}

const sharedSaver = new MemorySaver(); // stands in for Supabase: shared across "restarts"

function makeModule(passOnCall: number) {
  @Module({
    controllers: [RunsController],
    providers: [
      { provide: ENV, useValue: stubEnv },
      { provide: MODEL, useValue: stubModel(passOnCall) },
      // Per-role overrides off in the smoke — every role uses the stub MODEL.
      { provide: ROLE_MODELS, useValue: {} },
      { provide: MEMORY, useValue: null },
      {
        provide: CHECKPOINTER,
        useValue: { saver: sharedSaver, persistent: true, close: async () => {} },
      },
      RunsService,
      { provide: APP_GUARD, useClass: ApiKeyGuard },
    ],
  })
  class SmokeModule {}
  return SmokeModule;
}

async function boot(passOnCall: number): Promise<{ app: INestApplication; url: string }> {
  const app = await NestFactory.create(makeModule(passOnCall), { logger: false });
  await app.listen(0, "127.0.0.1");
  return { app, url: (await app.getUrl()).replace("[::1]", "127.0.0.1") };
}

const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`ok: ${msg}`);
};

// ---- instance 1 ----
const first = await boot(2);
const client = new AgentClient({ baseUrl: first.url, apiKey: API_KEY });

// 401 without / with wrong key (criterion 6)
for (const headers of [{}, { Authorization: "Bearer wrong-key-wrong-key-wrong" }]) {
  const res = await fetch(`${first.url}/runs`, { headers });
  assert(res.status === 401, `401 without valid key (got ${res.status})`);
}

// start a run (criterion 2)
const started = await client.startRun({ task: "smoke task", options: { maxRounds: 3 } });
assert(!!started.runId && started.runId === started.threadId, "POST /runs returns runId=threadId");
assert(started.status === "running", "POST /runs returns status running");

// validation
const bad = await fetch(`${first.url}/runs`, {
  method: "POST",
  headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ task: "" }),
});
assert(bad.status === 400, "POST /runs rejects empty task with 400");

// SSE stream (criterion 4)
const seen: RunEvent[] = [];
const abort = new AbortController();
for await (const event of client.streamRun(started.runId, { signal: abort.signal })) {
  seen.push(event);
  if (event.type === "awaiting_human") break;
}
abort.abort();
const types = seen.map((e) => e.type);
assert(types.includes("node"), `stream emits node events (${types.join(",")})`);
assert(types.includes("verdict"), "stream emits verdict events");
assert(types.at(-1) === "awaiting_human", "stream emits awaiting_human at the gate");
const verdicts = seen.filter((e) => e.type === "verdict");
assert(verdicts.length === 2 && verdicts[1]!.pass === true, "two rounds, second verdict passes");

// fetch state (criterion 3)
let detail = await client.getRun(started.runId);
assert(detail.status === "awaiting_human", "GET /runs/:id shows awaiting_human");
assert(detail.draft === "draft v2" && detail.round === 2, "GET /runs/:id returns live draft + round");
assert(detail.messages.length >= 4, `transcript present (${detail.messages.length} messages)`);

// decision before gate on a fresh run id -> 404 / wrong-state -> handled
const missing = await fetch(`${first.url}/runs/00000000-0000-0000-0000-000000000000`, {
  headers: { Authorization: `Bearer ${API_KEY}` },
});
assert(missing.status === 404, "GET unknown run -> 404");

// ---- "restart": close instance 1, boot instance 2 on the same saver (criterion 8 mechanics) ----
await first.app.close();
const second = await boot(2);
const client2 = new AgentClient({ baseUrl: second.url, apiKey: API_KEY });

detail = await client2.getRun(started.runId);
assert(detail.status === "awaiting_human", "after restart: run still awaiting_human via checkpointer");

// resume the gate over HTTP (criterion 5)
const decided = await client2.decide(started.runId, { decision: "approve", notes: "ser fint ud" });
assert(decided.status === "accepted", "POST /decision approve -> accepted");
detail = await client2.getRun(started.runId);
assert(detail.status === "accepted", "GET /runs/:id reflects accepted after decision");
assert(
  detail.messages.some((m) => m.content.includes("Reviewer notes: ser fint ud")),
  "reviewer notes persisted to transcript",
);

// double decision -> 409
const again = await fetch(`${second.url}/runs/${started.runId}/decision`, {
  method: "POST",
  headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ decision: "approve" }),
});
assert(again.status === 409, "second decision -> 409 conflict");

// reject path maps to 'rejected'
const r2 = await client2.startRun({ task: "reject me" });
for await (const event of client2.streamRun(r2.runId)) {
  if (event.type === "awaiting_human") break;
}
const rejected = await client2.decide(r2.runId, { decision: "reject" });
assert(rejected.status === "rejected", "POST /decision reject -> rejected (not failed)");

// list view
const listed = await client2.listRuns();
assert(listed.some((r) => r.runId === r2.runId), `GET /runs lists runs (${listed.length})`);

await second.app.close();
console.log("\nAll API smoke scenarios passed.");
process.exit(0);
