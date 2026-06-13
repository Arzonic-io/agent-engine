# Agent Engine

Internal multi-agent engine for Arzonic. v1 is a builder ↔ critic loop orchestrated
with LangGraph.js that refines a single task until a rubric passes or a round limit
is hit, with a human approval gate before anything is accepted. Runs as a CLI.

Full spec: [docs/design-brief.md](docs/design-brief.md).

## Layout

| Package | Purpose |
|---|---|
| `packages/core` (`@arzonic/agent-core`) | Graph, nodes, state schema, rubric, guardrails. Pure TS — only `@langchain/langgraph`, `@langchain/core`, `zod`. No HTTP, no transport, no framework. This is the reuse contract with Ranky. |
| `packages/shared` (`@arzonic/agent-shared`) | Env loading (zod-validated), Supabase client, `getModel()` LLM factory. |
| `apps/cli` (`@arzonic/agent-cli`) | v1 entrypoint: runs the graph on one task, streams steps, handles the human gate, owns the checkpointer. |
| `apps/api` (`@arzonic/agent-api`) | Phase 2: NestJS HTTP service exposing core — start runs, watch them over SSE, drive the human gate over HTTP. The only place Nest is allowed. |
| `packages/client` (`@arzonic/agent-client`) | Thin typed HTTP client (zero deps) for Ranky/Bravy. Also the source of truth for the wire types the api serves. |

## Setup

Requires Node >= 20 and pnpm.

```bash
pnpm install
cp .env.example .env   # fill in at least the API key for your provider
pnpm build
```

Minimal `.env`:

```bash
LLM_PROVIDER=mistral        # or anthropic
MISTRAL_API_KEY=...         # or ANTHROPIC_API_KEY
```

## Run

```bash
pnpm agent "Write a launch plan for feature X"
```

The CLI streams each node step (builder rounds, critic verdicts), then pauses at the
human gate. Answer `a` to approve (status `accepted`) or `r` to reject (status
`failed`). The final draft, structured verdict, and full transcript are printed at
the end.

Guardrails (all env-driven): `MAX_ROUNDS` (default 3, hard stop), `RUN_TOKEN_BUDGET`
(optional — run is marked `failed` when exceeded), `RUN_TIMEOUT_MS` (default 300000 —
the run is aborted on timeout).

## Persistence & resume

By default the checkpointer is LangGraph's in-memory `MemorySaver` — fine for local
runs, nothing survives the process.

Set `SUPABASE_DB_URL` (Supabase → Settings → Database → connection string) to switch
to the Postgres checkpointer (`@langchain/langgraph-checkpoint-postgres`). Every run
then persists under its thread id (printed at start), and an interrupted run — e.g.
one paused at the human gate, or killed by the timeout — can be resumed:

```bash
pnpm agent --thread <thread-id>
```

The checkpointer is injected into `createAgentGraph()` by the runtime; core never
owns persistence. That is deliberate — it keeps `@arzonic/agent-core` importable
into any host (Next.js included) without dragging in pg/Supabase.

## Editing the rubric

The rubric is the main quality lever. It lives in
[packages/core/src/rubric.ts](packages/core/src/rubric.ts) as a plain config object
(`defaultRubric`): a list of criteria (`id`, `description`, `required`) plus a
`passThreshold` (0–100).

- A draft passes only when **all `required` criteria are met AND `score >=
  passThreshold`** — this rule is enforced in code (`criticNode`), not delegated to
  the model.
- Add/edit criteria by editing the object; the critic prompt renders them
  automatically.
- Hosts can pass a custom rubric per run: `createAgentGraph({ model, checkpointer,
  rubric })`.

## HTTP service (`apps/api`)

Start locally (requires `AGENT_API_KEY` ≥ 16 chars in `.env`; set `SUPABASE_DB_URL`
so runs survive restarts — without it the api warns and uses the in-memory saver):

```bash
pnpm build
node apps/api/dist/main.js     # listens on API_PORT (default 8787)
```

Every route requires `Authorization: Bearer $AGENT_API_KEY` and returns 401 otherwise.

| Route | Purpose |
|---|---|
| `POST /runs` | Start a run. Body `{ task, rubricId?, options?: { maxRounds? } }` → `{ runId, threadId, status }`. Returns immediately; work continues async. |
| `GET /runs/:id` | Status, round, draft, verdict, full transcript. Status: `running \| awaiting_human \| accepted \| rejected \| failed`. |
| `GET /runs/:id/stream` | SSE. Typed events: `node`, `verdict`, `awaiting_human`, `done`, `error`. Live + replay from run start. |
| `POST /runs/:id/decision` | The human gate. Body `{ decision: 'approve' \| 'reject', notes? }`. Approve → `accepted`, reject → `rejected`. 409 if the run isn't paused at the gate. |
| `GET /runs` | Recent runs for a list view (in-process registry; cleared on restart — state itself is in the checkpointer). |

Smoke-test the whole surface with curl:

```bash
KEY=$AGENT_API_KEY; BASE=http://127.0.0.1:8787
curl -s -X POST $BASE/runs -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"task":"Write a launch plan for feature X"}'          # -> {"runId":"..."}
curl -N $BASE/runs/<id>/stream -H "Authorization: Bearer $KEY"  # watch live events
curl -s -X POST $BASE/runs/<id>/decision -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -d '{"decision":"approve"}'
```

Notes on behaviour:

- Run ids double as LangGraph thread ids, so with `SUPABASE_DB_URL` set a run
  paused at the gate survives a process restart — `GET /runs/:id` and
  `POST /decision` work purely off the checkpointer.
- Reject currently always ends the run as `rejected`; "loop once more with notes"
  needs a `humanGate → builder` edge in core's graph and is deferred to the phase
  that next touches core. `notes` are appended to the persisted transcript.
- A wiring smoke test lives at `apps/api/smoke.ts`
  (`pnpm --filter @arzonic/agent-api run smoke`) — boots the app with a stub
  model, no API keys needed.

### PM2 / VPS

```bash
pnpm install && pnpm build
pm2 start ecosystem.config.cjs   # runs apps/api/dist/main.js as "agent-api"
```

Put it behind the CloudPanel reverse proxy on its own port (`API_PORT`), ideally
internal-only or on a non-discoverable subdomain. Set `API_CORS_ORIGINS` to the
exact Ranky/Bravy origins.

### Consuming from Ranky / Bravy

Product apps call the service — they never import core. Install
`@arzonic/agent-client`:

```ts
import { AgentClient } from "@arzonic/agent-client";

const agent = new AgentClient({
  baseUrl: process.env.AGENT_API_URL!,
  apiKey: process.env.AGENT_API_KEY!, // server-side only — NEVER in the browser
});

const { runId } = await agent.startRun({ task: "..." });
for await (const event of agent.streamRun(runId)) { /* node/verdict/awaiting_human/done */ }
await agent.decide(runId, { decision: "approve" });
```

In Ranky (Next.js) keep all calls in route handlers / server actions; in Bravy
(NestJS) wrap the client in a small `AgentClientService`. `AGENT_API_KEY` must
never reach a browser.

## Tracing

Set `LANGSMITH_TRACING=true` and `LANGSMITH_API_KEY` to enable LangSmith tracing.
Off by default.

## Deployment

Plain Node processes — `pnpm build`, then `pm2 start ecosystem.config.cjs` for the
api; the CLI runs ad hoc. All secrets via env; nothing is hardcoded.

## What's next (not built yet)

- **Architect / lead agents**: add nodes next to `builder`/`critic` in
  `packages/core/src/nodes/` and wire them in `packages/core/src/graph.ts` — e.g.
  `START → architect → builder` for upfront task decomposition, and a `lead`
  orchestrator deciding routing instead of the static conditional edge. State and
  rubric are already agent-agnostic (`AgentMessage.agent` is a string enum — extend
  it).
- **Slack/Mattermost relay** of the SSE stream, and a dashboard subscribing via
  Supabase Realtime.
- **Reject-and-revise**: a `humanGate → builder` edge in core so a rejection with
  notes can trigger one more round instead of ending the run.
- **Ranky**: lift `packages/core` into the Ranky repo (or publish `@arzonic/agent-core`)
  and inject Ranky's own model, rubric, and checkpointer — or just consume this api
  via `@arzonic/agent-client` ("run once, serve everywhere").
