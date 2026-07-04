# Agent Engine

Internal multi-agent engine for Arzonic. A project-scoped, web-first orchestrator built
on LangGraph.js that runs work in two modes:

- **Task** — a bounded, human-gated run. A router picks a builder ↔ critic loop or a full
  architect → workers → lead team, refines until a rubric passes or a round limit hits,
  and stops at a human approval gate. Minutes, not hours.
- **Mission** — a long-running, self-driving goal. The engine plans its **own** backlog,
  writes and tests real code in isolated git worktrees, has a critic challenge each diff,
  verifies with real checks, integrates, re-plans, and loops until the goal is met or a
  governor stops it. The human is an **async overseer** (review queue, kill switch, morning
  digest, mid-run course-correction), never a gate on every step.

Both modes run inside a **project** — a repo + a persistent memory (pgvector RAG) the agents
carry across runs. The reusable heart (`@arzonic/agent-core`) is pure TypeScript with no HTTP,
transport, or framework, so it can be lifted into Ranky/Bravy or consumed over HTTP.

Full concept & north star: [docs/design-brief.md](docs/design-brief.md). Living plan and
delivery log: [docs/BACKLOG.md](docs/BACKLOG.md).

## The team ("stillinger")

Each role owns one kind of LLM call and can run on its **own** provider/model/temperature
(e.g. Mistral plans, a deterministic Gemini critiques, Claude writes the code):

| Role | Job |
|---|---|
| `decompose` | Goal → an ordered, dependency-aware backlog (mission start) |
| `architect` | Designs the steps / decomposes a team task |
| `builder` / `worker` | Produces the draft (task mode) |
| `implementer` | Writes real code in a worktree via write-tools (mission mode) |
| `critic` | Challenges the work against acceptance criteria / the rubric |
| `tester` | Authors a test that exercises the change before verification |
| `lead` | Synthesises the team's output |
| `replan` | After each item: done / retry / park + propose follow-ups |
| `analyst` | Read-only repo analysis |
| `router` | Picks single vs. team topology |

Configure them globally (`LLM_ROLE_MODELS` env or the Settings UI), per project, or per
mission — most-specific wins: **mission > project > global default (DB) > env**.

## Layout

| Package | Purpose |
|---|---|
| `packages/core` (`@arzonic/agent-core`) | Graphs, nodes, state/mission schemas, rubric, guardrails, the `runMission` controller loop and all its injected seams (BacklogStore, Verifier, WorkRunner, Integrator, Differ, Replanner, Decomposer, …). **Pure TS** — only `@langchain/*` + `zod`. No HTTP, no `pg`, no `Date.now()`. The reuse contract. |
| `packages/shared` (`@arzonic/agent-shared`) | The runtime: env loading (zod-validated), the multi-provider `buildModel`/`buildRoleModels` factory (Mistral/Claude/Gemini + prompt-caching + transient-retry), Postgres-backed project memory, mission backlog, app settings, git worktree manager, integrator, differ, verifier, write-capable repo tools. |
| `packages/client` (`@arzonic/agent-client`) | Thin typed HTTP client (zero deps) **and** the source-of-truth wire types `apps/api` serves — they can't drift. |
| `apps/api` (`@arzonic/agent-api`) | NestJS HTTP service (the only place Nest lives) + the PM2 **mission worker** process. |
| `apps/web` (`@arzonic/agent-web`) | Next.js dashboard — the primary UX. Projects, the Task/Mission composer, the mission board, approvable diffs, the morning digest, course-correction. Talks to the API only through server-side proxy routes (the bearer key never reaches the browser). |
| `apps/cli` (`@arzonic/agent-cli`) | Ad-hoc CLI: run one task, or analyze a repo. |

## Setup

Requires **Node 22** (pinned in [.nvmrc](.nvmrc) — `nvm use`; the engine floor is ≥ 20)
and **pnpm**.

```bash
pnpm install
cp .env.example .env        # see Configuration below
docker compose up -d        # local pgvector Postgres (memory + checkpointer + backlog)
pnpm build
```

Minimal `.env` to get running with persistence:

```bash
LLM_PROVIDER=mistral
MISTRAL_API_KEY=...                 # a key for whichever provider(s) you use
AGENT_API_KEY=<at least 16 chars>   # bearer key the web proxy / clients send
SUPABASE_DB_URL=postgresql://agent:devpassword@127.0.0.1:5432/agent_engine
REPO_ALLOWED_ROOTS=/Users/<you>/Documents/GitHub   # dirs the repo picker may list
```

Without `SUPABASE_DB_URL` the engine falls back to LangGraph's in-memory saver (Task mode
works; projects/memory/missions need the database). See `.env.example` for the full,
annotated list of every variable.

## Run

### Web app (primary UX)

```bash
pnpm dev      # web on http://localhost:3400, API on http://localhost:8787
```

`pnpm dev` runs the API and the web app together (and `predev` starts the local Postgres
and frees the ports). Open the web app, create a project, pick its repo — a searchable
**GitHub repo picker** when `GITHUB_TOKEN` is set (the repo is auto-cloned into a managed
workspace under `MISSION_WORKSPACE_ROOT`), or a local path — and choose **Opgave** (Task)
or **Mission**.

### Mission worker

Missions are driven by a **separate worker process** that scans for `running` missions and
runs `runMission` for each. In dev:

```bash
pnpm --filter @arzonic/agent-api worker:dev
```

In production it's a PM2 process (see below). The API owns intake, the kill switch, the
parked-item decisions, and mid-run course-correction; the worker does the work.

### CLI (ad hoc)

```bash
pnpm agent "Write a launch plan for feature X"   # one bounded task, human gate at the end
pnpm analyze                                     # read-only repo analysis
```

## Configuration

Everything is env-driven (`.env`, zod-validated at boot). Highlights — full list in
[.env.example](.env.example):

- **Providers & models** — `LLM_PROVIDER` (mistral | anthropic | google), per-provider keys,
  `LLM_MODEL`, and `LLM_ROLE_MODELS` (per-role `{provider, model?, temperature?}` JSON).
  `LLM_PROMPT_CACHE` (default on) caches Claude's stable prompt prefix at ~0.1×.
  Gemini also runs **key-less via Vertex AI/ADC**: set `GOOGLE_CLOUD_PROJECT`
  (+ `GOOGLE_CLOUD_LOCATION`, default `europe-west4`) instead of `GOOGLE_API_KEY`.
- **Persistence** — `SUPABASE_DB_URL` (Postgres checkpointer + memory + backlog),
  `SUPABASE_URL` / `SUPABASE_SERVICE_KEY`.
- **Task guardrails** — `MAX_ROUNDS`, `RUN_TOKEN_BUDGET`, `RUN_TIMEOUT_MS`.
- **Mission governors** — `MISSION_TOKEN_BUDGET`, `MISSION_MAX_ITERATIONS`,
  `MISSION_NOPROGRESS_LIMIT`, `MISSION_THRASH_LIMIT`, `MISSION_CONCURRENCY`,
  `MISSION_REQUEUE_LIMIT`, `MISSION_LLM_MAX_RETRIES`, `MISSION_REVIEW_ROUNDS`,
  `MISSION_AUTHOR_TESTS`, `MISSION_CHECKS`, `MISSION_HIGH_RISK_PATTERNS`,
  `MISSION_WORKER_POLL_MS`, `MISSION_ABORT_POLL_MS` (preemptive kill-switch/deadline
  watcher), `MISSION_MAX_STRATEGIC_REPLANS` (re-decompose toward the goal when the
  backlog drains).
- **Notifications** — `MISSION_NOTIFY_WEBHOOK_URL` (Slack/Discord/Mattermost incoming
  webhooks work directly) delivers parked-item alerts, the morning digest, and stop
  events out-of-band; `MISSION_DIGEST_INTERVAL_MS` adds a mid-run digest on a timer so a
  mission still running in the morning reports *before* it ends.
- **GitHub: repo picker + publishing** — `GITHUB_TOKEN` (fine-grained PAT with
  Contents + Pull-requests read/write) enables the searchable repo picker (clones live
  under `MISSION_WORKSPACE_ROOT`, default `.workspaces`) and lets a finished mission push
  its integration branch and open a PR against the default branch: `MISSION_PUBLISH_PR`
  (default on), `MISSION_PR_DRAFT` (default draft). The PR URL + stop reason are
  persisted on the mission and linked from the dashboard.
- **MCP knowledge bases (M4)** — `MISSION_MCP_SERVERS` gives the mission implementer a
  permanent, on-demand knowledge base via [MCP](https://modelcontextprotocol.io) servers
  (e.g. a daisyUI blueprint so every UI mission builds on-brand markup). The value is the
  same JSON as a Claude-Desktop `claude_desktop_config` (`{ "mcpServers": { … } }`), on one
  line — paste a config straight in. Servers connect once at worker boot and their tools
  join the implementer's belt; best-effort, so a missing/broken server just means those
  tools are absent, never a crashed mission.
- **Repo sandbox** — `REPO_ALLOWED_ROOTS` (which dirs the picker lists), `REPO_ALLOWED_CHECKS`
  (pnpm scripts the Verifier may run), `REPO_ALLOWED_COMMANDS` (executables a mission may run,
  no shell — `&&`/pipe/`$(…)` are inert).
- **API** — `AGENT_API_KEY` (≥16 chars), `API_PORT` (8787), `API_CORS_ORIGINS`.
- **Web** — `WEB_LOCAL_REPOS=off` (recommended on the cloud deploy) hides local-path repo
  binding entirely: the browser can never reach your own machine's disk, and binding
  missions to VPS paths (incl. the live deployment repo) is a footgun — GitHub picking is
  the only binding there. Local dev leaves it on: there the API *is* your machine.
- **Tracing** — `LANGSMITH_TRACING` + `LANGSMITH_API_KEY` (off by default).

## Architecture

### Task graphs (`packages/core/src/graph.ts`)

- `createAgentGraph` — builder ↔ critic loop with the rubric and a human gate.
- `createTeamGraph` — architect → workers → lead for decomposable work.
- `createProjectGraph` — retrieve project memory → router (single | team) → run → gate →
  persist memory. This is what a project Task runs.
- `createRepoAnalysisGraph` — an analyst with read-only repo tools.

The **rubric** ([packages/core/src/rubric.ts](packages/core/src/rubric.ts)) is the quality
lever: a draft passes only when **all `required` criteria are met AND `score ≥ passThreshold`**,
enforced in code (`criticNode`), never delegated to the model.

### Missions engine (`packages/core/src/controller.ts`)

`runMission(deps, missionId)` is a pure, provably-terminating loop. For each actionable
backlog item it:

1. **picks a batch** (high-risk items parked for a human *before* they run),
2. **runs** each item in its own git **worktree** — the implementer writes real code, an
   optional tester authors a test, then a **critic** challenges the real `git diff`,
3. **captures a structured diff** of what was written (for human review),
4. **verifies** the authored code with real checks — the Verifier's exit code, not an LLM, is
   the sole truth for "done",
5. **integrates**: merges the green item into the mission branch and **re-verifies there**
   (two independently-green items can still sum to red → rolled back + parked),
6. **re-plans**: the lead decides done / retry / park and proposes follow-ups.

Governors (budget, deadline, iterations, no-progress, thrash, concurrency, requeue) guarantee
termination; transient infra blips are retried/re-queued, real failures are surfaced and
parked — never swallowed. When the mission stops it **publishes**: the integration branch
is pushed and a (draft) PR opened against the repo's default branch (idempotent — an open
PR is reused), and the PR URL + the machine-readable stop reason are persisted on the
mission row, so the dashboard links the night's work and explains why it ended. It then
delivers a **morning digest** (what's done, what's blocking and why, the next high-risk
work, the PR link) via the notifier — to the console and, with `MISSION_NOTIFY_WEBHOOK_URL`,
out-of-band to Slack/Discord/Mattermost. A human can drop free-text **guidance** onto a
running mission at any time; it flows into the next planning round (course-correction
beyond Stop).

Everything the loop touches is an **injected seam** (BacklogStore, Verifier, WorkRunner,
WorktreeManager, Integrator, Differ, Decomposer, Replanner, TestAuthor, Notifier, Clock,
governors), so `core` stays pure and the whole loop is resume-safe: re-invoking
`runMission` after a crash requeues any in-flight item and continues.

## HTTP API

NestJS service on `API_PORT` (8787). Every route requires `Authorization: Bearer
$AGENT_API_KEY` (401 otherwise). The web app reaches it only via server-side proxy routes.

| Area | Routes |
|---|---|
| Tasks / runs | `POST /runs`, `GET /runs`, `GET /runs/:id`, `GET /runs/:id/stream` (SSE), `POST /runs/:id/decision` |
| Projects | `POST /projects`, `GET /projects`, `GET /projects/:id`, `PATCH /projects/:id`, `DELETE /projects/:id`, `GET /projects/:id/tasks`, `POST /projects/:id/tasks` |
| Missions | `POST /missions`, `GET /missions`, `GET /missions/:id`, `GET /missions/:id/stream` (SSE), `POST /missions/:id/stop`, `PATCH /missions/:id/role-models`, `PATCH /missions/:id/guidance`, `POST /missions/:id/items/:itemId/decision`, `GET /missions/:id/items/:itemId/diff` |
| Settings | `GET /settings`, `PUT /settings/role-models` |
| Misc | `GET /repos`, `GET /rubric`, `GET /tasks` |

A wiring smoke test that boots the app with a stub model (no API keys needed) lives at
`apps/api/smoke.ts` — `pnpm --filter @arzonic/agent-api run smoke`.

## Testing

There is no test framework; correctness is proven by **standalone harnesses** run with `tsx`,
each a throwaway proof of one slice (in-memory fakes for logic, real temp git repos for
integration). Examples:

```bash
pnpm build                                                   # turbo: 6/6 packages typecheck + compile
pnpm --filter @arzonic/agent-core exec tsx verify-mission.ts # the controller loop
pnpm --filter @arzonic/agent-shared exec tsx verify-differ.ts# the git differ, against a real repo
pnpm --filter @arzonic/agent-api run smoke                   # the HTTP surface
```

See `packages/*/verify-*.ts` for the full set (mission, decompose, replan, drift, tester,
team graph, integrator, worktree, role-models, prompt-cache, differ, human-policy, …).

## Production (PM2 / VPS)

```bash
pnpm install && pnpm build
pm2 start ecosystem.config.cjs   # starts agent-api + agent-mission-worker + agent-web (:3400)
```

All three are single-fork processes sharing the VPS's native Postgres. Deploys run
push→main → a self-hosted runner ([.github/workflows/deploy.yml](.github/workflows/deploy.yml)):
reset → build → restart all three by name. Put the API behind the reverse proxy on
`API_PORT` (internal-only or a non-discoverable subdomain), set `API_CORS_ORIGINS` to the
exact consumer origins, and note the API's CORS allows only GET/POST — the web app reaches
PATCH/DELETE through its own server-side proxy routes. Set `WEB_LOCAL_REPOS=off` so the UI
offers GitHub repo picking only (no VPS filesystem paths). All secrets via the repo-root `.env`.

## Consuming from Ranky / Bravy

Product apps call the service — they never import core. Install `@arzonic/agent-client`:

```ts
import { AgentClient } from "@arzonic/agent-client";

const agent = new AgentClient({
  baseUrl: process.env.AGENT_API_URL!,
  apiKey: process.env.AGENT_API_KEY!, // server-side only — NEVER in the browser
});

const { runId } = await agent.startRun({ task: "..." });
for await (const event of agent.streamRun(runId)) { /* node / verdict / awaiting_human / done */ }
await agent.decide(runId, { decision: "approve" });
```

Keep all calls server-side (Next.js route handlers / a small NestJS `AgentClientService`).
`AGENT_API_KEY` must never reach a browser.
