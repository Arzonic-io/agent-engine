# Design Brief — Agent Engine

**Single source of truth.** This is the living spec: what the engine *is today*
(as-built, §3–4) and where it's *going* (the autonomous-missions north star, §5+).
It supersedes the earlier phased briefs (v1 / Phase 2 / Phase 3 / Phase 4), now
folded in here. The checkbox-level roadmap lives in [BACKLOG.md](BACKLOG.md).

**Last updated:** 2026-06-16

---

## 1. Purpose

Agent Engine is Arzonic's internal multi-agent engine. Role-based agents collaborate
and challenge each other to produce higher-quality output than a single model pass.
It runs as a CLI, an HTTP service (`apps/api`), and a web dashboard (`apps/web`);
`packages/core` is portable and meant to be lifted into Ranky/Bravy.

---

## 2. Non-negotiables

- **TypeScript everywhere**; **LangGraph.js** is the orchestration engine.
- **`packages/core` is pure TS — framework-free** (no Nest/HTTP/transport). The reuse
  contract with Ranky: importable into Next.js untouched. New capabilities (memory,
  repo tools, the mission controller, tester tools) enter core as **injected
  interfaces** — exactly like `ProjectMemory` and `RepoTools` already are.
- **Nest only ever lives in `apps/api`.**
- **Provable termination**: bounded loops (`MAX_ROUNDS`, token/cost budget, per-run
  timeout) for tasks; governors (budget/deadline/iterations/no-progress) for missions.
- **Human-in-the-loop** before `accepted` for tasks; for missions the human never
  blocks the loop (park-risk + async approval, §5.5).
- **Env-driven**; no secrets in code. Deployable as plain Node processes under PM2.

---

## 3. Architecture as-built

### 3.1 The four graphs (`packages/core/src/graph.ts`)

One `GraphState`, shared nodes; the runtime picks one per request, or a router picks.

- **`createAgentGraph` — single (v1):**
  `builder → critic → [pass | round≥MAX → humanGate ; else → builder]`;
  `humanGate → [approve → END(accepted) | revise → builder | reject → END]`.
- **`createTeamGraph` — the team:** `architect → worker×N → lead → critic → … →
  humanGate`. Architect plans 3–6 zod-validated steps; a worker runs per step; the
  lead synthesizes one draft and revises on critic/human notes.
- **`createProjectGraph` — persistent project team (adaptive):**
  `retrieveContext → router → [team | single] → critic → … → humanGate →
  persistMemory`. Pulls brief + top-k pgvector memory into `context`; router picks
  the lightest topology; persistMemory stores the accepted result.
- **`createRepoAnalysisGraph` — grounded, read-only:** `analyst (tool-using) →
  critic → [pass | round≥MAX → done]`. No gate; injected read-only `RepoTools`,
  sandboxed by the runtime.

### 3.2 State (`packages/core/src/state.ts`)

`task, messages, draft, round, verdict, status, tokensUsed` plus `humanNotes`,
`plan[]`, `currentStep`, `stepResults[]`, `projectId`, `context`,
`topology: 'single' | 'team'`. `AgentMessage.agent` ∈ {builder, critic, human,
system, analyst, architect, lead, worker}.

### 3.3 Rubric / Definition of Done (`packages/core/src/rubric.ts`)

A config object (`defaultRubric`): criteria (`id, description, required`) +
`passThreshold`. **Pass = all required criteria met AND score ≥ threshold**, enforced
in code (`criticNode`). Hosts can pass a custom rubric per run.

### 3.4 Memory (core interface + `@arzonic/agent-shared` impl)

Core defines memory as a pure interface (`retrieve`, `store`); the pgvector-backed
`MemoryService` lives in shared and is injected. Owns `projects`, `tasks`,
`project_memory` (kinds: brief/artifact/decision/note). Needs `SUPABASE_DB_URL`
(Postgres + pgvector) + `MISTRAL_API_KEY`; without them, project/memory features are
disabled and the other graphs still work.

### 3.5 API (`apps/api`, NestJS, bearer-guarded)

`runs` (`POST/GET /runs`, `GET /runs/:id`, `SSE /runs/:id/stream`, `DELETE`,
`POST /runs/:id/decision`); `projects` (`POST/GET`, `GET/PATCH/DELETE /:id`,
`POST/GET /:id/tasks`); `repos` `GET /repos`; `rubric` `GET /rubric`; `tasks`
`GET /tasks` (global feed).

### 3.6 Web (`apps/web`, Next.js)

Project-first dashboard proxying the API via server-side `/api/*` handlers (keeps
`AGENT_API_KEY` server-side). Project-scoped composer (memory indicator, team roster,
Definition of Done, repo-per-project); sidebar with projects + global recent-tasks
feed; run view streams the debate with a human-gate inspector.

### 3.7 Clients & deploy

`@arzonic/agent-client` — zero-dep typed HTTP client + source of truth for wire
types. API deploys to the VPS via PM2; CLI runs ad hoc; persistence/resume via the
Postgres checkpointer (run id = thread id).

### 3.8 Per-role models (the configurable team members)

Each role that owns an LLM call can be assigned its **own** model/provider — e.g.
Mistral as the architect, **Gemini Flash** as the (cheap) critic, **Claude** as the
implementer. Core stays pure: it defines `ModelRole` + a `pickModel` seam, and every
graph takes a `model` (fallback) plus an optional `models: RoleModels` map; a node
resolves `models[role] ?? model`. The runtime builds the map from `LLM_ROLE_MODELS`
(JSON `role→{provider,model?}`) via `buildRoleModels(env)` in `@arzonic/agent-shared`,
which is the single place provider SDKs (`@langchain/anthropic|mistralai|google-genai`)
are instantiated. Unassigned roles fall back to `LLM_PROVIDER`, so it's purely
additive. Roles: `architect, worker, lead, critic, builder, implementer, analyst,
router, replan, decompose, tester`. (`tester` = the M3 Trin 2 test-author; e.g. a
cheap Gemini tester over a Claude implementer.)

**Per-mission team config (persisted).** Beyond the global env default, each mission
stores its OWN role→model map on its `missions` row (`role_models` jsonb, §5.2), set
in the mission setup flow. The worker resolves a mission's agents with
`buildRoleModels(env, mission.roleModels)` — the mission's choices **merge over** the
global default per role — so one mission can run Claude-implements/Gemini-critiques
while another inherits the default. The config is plain data end-to-end (core defines
`ModelSpec`/`RoleModelsConfig`; the API validates that every referenced provider has a
key server-side). *(Open: per-role temperature; prompt-caching on stable system
prompts; a per-project default; editing a running mission's team — §6 M3.)*

---

## 4. Guardrails / termination (tasks, provable today)

Worker loop runs exactly `plan.length` times; builder↔critic / lead↔critic capped by
`MAX_ROUNDS`; `RUN_TOKEN_BUDGET` routes any node to `fail`; `RUN_TIMEOUT_MS` aborts
via AbortController; the human gate is the only unbounded wait (explicit interrupt).

---

## 5. North star — Autonomous Missions

The direction: **from** bounded, human-gated single tasks **to** long-running
**autonomous missions** that keep working — overnight, at a steady tempo — planning
their own backlog, executing, **verifying against a real repo**, self-critiquing,
re-planning, and looping until the goal is met or a governor stops them. The four
graphs stay the "do one unit of work well" engine; a mission is an **outer controller
loop** that keeps feeding them work. It does **not** replace tasks — it's a second
mode beside them.

### 5.1 Two modes

| | **Task** (existing) | **Mission** (new) |
|---|---|---|
| Duration | ≤ ~15 min | hours / overnight |
| Loop | `MAX_ROUNDS` then stop | until done / budget / time / no-progress |
| Human | blocking gate | **never blocks** — risky items parked, async digest |
| Truth of "done" | critic rubric | **build/test/lint pass on a real repo** |

### 5.2 Mission model (new Postgres tables, beside project memory)

- **`missions`**: `id, projectId, goal, acceptanceCriteria[], repoPath, status
  (running | paused | blocked | done | failed | stopped), budget, spentTokens,
  deadline, roleModels (per-mission team config, §3.8), createdAt`.
- **`backlog_items`**: `id, missionId, title, detail, status (todo | in_progress |
  done | blocked_needs_human | failed), priority, dependsOn[], risk (low | high),
  runId, verification (check result), createdAt, updatedAt`.

Workspace = `repoPath` (validated against `REPO_ALLOWED_ROOTS`, reusing the sandbox).
Journal = ordered backlog history + each item's run transcript (already checkpointed).

### 5.3 The controller loop (pure core, injected I/O)

A pure async function in core — `runMission(deps, missionId)`:

```
while (status === running):
    if (budget/time/iteration ceiling hit)   → stop(reason)
    if (no actionable items)                  → done | blocked | stop
    item   = backlog.nextActionable(missionId)        # lead prioritises, respects dependsOn
    mark item in_progress
    result = runWorkItem(item)                        # existing project/team graph, checkpointed by item.id
    verify = verifier.run(repoPath, checks)           # run_check: test/lint/typecheck/build — truth source
    review = replan(goal, item, result, verify, backlog)   # lead: pass/fail + new/updated items
    apply review to backlog (done / add follow-ups / mark blocked)
    if (no-progress or thrash detected)       → stop(reason)
    checkpoint                                        # survives restart
```

Injected deps (interfaces in core; concrete impls in api/shared): **`BacklogStore`**
(missions + items), **`Verifier`** (wraps `run_check`; pass/fail is the truth, not the
LLM), **`WorkRunner`** (runs one item through a compiled graph → deliverable + runId),
**`Notifier`** (async events: parked item, digest, done), **`Clock`/`Budget`**
(deadline + ceilings — no `Date.now()` in core; pass time in).

### 5.4 Roles

- **Orchestrator/Lead** — owns the backlog: prioritises, sets work in motion, re-plans from results.
- **Implementer** — writes real code in the item's worktree (write tools, ReAct loop).
- **Critic** — challenges the implementer's *actual diff* and loops it back for revision (★, below).
- **Tester** — authors a test that *exercises* the built code before verification, so a
  green build is real evidence, not just "it compiles" (M3 Trin 2 ✓, below).
- **Verifier** — runs the real checks; its exit code, not the LLM, decides "done".

> **As-built (M3 ★ — the team challenges each item):** a mission item now runs
> through `createMissionTeamGraph` — `implementer → critic → [pass | revise]`,
> bounded by `MISSION_REVIEW_ROUNDS` (default 1). The critic reviews the **real
> `git diff`** (captured in code, not via an LLM tool, so no write capability is
> exposed to it) against the item's acceptance criteria and, on a fail, loops back
> to the implementer with concrete issues. This is the adversarial pass that catches
> **green-but-wrong** work — code that passes checks but misimplements intent —
> which the Verifier alone can't. The critic uses its **own configurable model**
> (§3.8/per-mission §3.8), e.g. a cheap Gemini critic over a Claude implementer.
> The Verifier (real checks) still independently decides "done"; the critic only
> adds a gate. Set `MISSION_REVIEW_ROUNDS=0` for the pre-★ lone-implementer path.

> **As-built (M3 Trin 2 — green = strong truth):** after the implementer (and
> critic) finish, an injected **`TestAuthor`** seam authors a test that genuinely
> exercises the change, in the item's worktree, **before** the Verifier runs — so
> the same check that gates "done" also runs the new test. The LLM impl
> (`makeTestAuthor`) is a ReAct loop reusing the implementer's write-tools, rooted
> in the worktree, `recursionLimit`-terminated; it may **only author tests, never
> touch implementation code** — if the code is wrong its test fails, which keeps the
> item open (the point). It **never reports pass/fail**: the Verifier's exit code
> stays the sole truth. Uses its own configurable **`tester`** model (§3.8). Gated by
> `MISSION_AUTHOR_TESTS` (default off ⇒ pre-Trin-2 behaviour); pair with a `test`
> check in `MISSION_CHECKS`. Writes are **confined to test files** (`*.test.*`,
> `__tests__/`, …) in code — not just by prompt — so the tester can't "fix" the
> impl to pass its own test. *Trade-off:* it biases toward "prove it" — a test that
> fails because the **test itself** is broken (not the code) also keeps the item
> open until a revision/thrash-park resolves it. *Proven:*
> [verify-tester.ts](../packages/core/verify-tester.ts) — an authored test is **red**
> on a buggy impl and **green** once fixed, and an attempt to write impl source is rejected.

### 5.5 Human policy — park-risk, run the rest (never block)

- **Risk classification** per item (planner + static high-risk rules): deploys, data
  deletion, payments, secrets, irreversible ops → `high`.
- **Low-risk + verified** → auto-applied, item closed.
- **High-risk** → `blocked_needs_human`; `Notifier` posts it; the loop moves on.
- **Async approval** clears parked items (API/dashboard), making them actionable again.
- **Morning digest**: done / parked / spend / next steps.

### 5.6 Safety governors (replace the v1 termination proof for missions)

Hard ceilings (`MISSION_TOKEN_BUDGET`, `MISSION_DEADLINE` wall-clock,
`MISSION_MAX_ITERATIONS`); **no-progress detector** (N iterations with no newly-
verified item → stop+flag); **thrash guard** (an item failing the same check
repeatedly → park the item, not the mission); **kill switch**
(`POST /missions/:id/stop`, halts at next checkpoint); live budget meter in the UI.

> **As-built (M3 Trin 3 — drift-robustness, "survive the night"):** two layers keep
> a long run alive through transient blips without hiding real failures. (1) **LLM
> retry** — every model is built (`buildModel`, shared) with an env-driven
> `MISSION_LLM_MAX_RETRIES` and a custom `onFailedAttempt` (`isTransientLlmError`)
> so the provider's AsyncCaller retries ONLY transient errors (429 / 5xx / timeout /
> network) with exponential backoff + jitter, and re-throws 4xx / auth / quota / a
> kill-switch abort immediately. (2) **Controller recovery** — an injected
> `isTransientError` predicate (core stays SDK-free) lets `runMission` catch a run
> that still throws: a transient/infra failure **re-queues** the item (a SEPARATE
> counter from the thrash budget, bounded by `MISSION_REQUEUE_LIMIT`, counted as
> no-progress so a persistent outage still stops the mission); a non-transient throw
> **parks** the item for a human with the error recorded — surfaced, never swallowed,
> and never crashing the concurrent batch. Emits an `item_retried` event (the
> structured retry log). *Proven:* [verify-retry.ts](../packages/shared/verify-retry.ts)
> (classifier + real AsyncCaller backoff) and [verify-drift.ts](../packages/core/verify-drift.ts)
> (transient recovers; non-transient surfaces; persistent outage terminates).

### 5.7 Mission API + worker (`apps/api`)

Behind the bearer guard: `POST /missions` `{ projectId, goal, repoPath,
acceptanceCriteria?, budget?, deadline? }`; `GET /missions` / `GET /missions/:id`;
`SSE /missions/:id/stream`; `POST /missions/:id/stop`;
`POST /missions/:id/items/:itemId/decision` (async approve/reject parked item). A
**PM2 mission-worker** process drives `runMission` for active missions (separate from
the API, sharing the Postgres checkpointer/backlog) — add it to `ecosystem.config.cjs`.

### 5.8 Worked example — "Build a webshop with full integration" (overnight)

Intake → backlog (catalog, cart, checkout, payments, auth, admin, seed data, tests,
deploy) → execute items via the team graph in the repo → verifier runs build/tests →
replan adds follow-ups (payment-failure handling, error/empty states, a11y,
validation) and parks high-risk items (which payment provider, deploy) → loop under
budget → by morning: a built+verified artifact, a backlog history, parked decisions,
and a digest.

---

## 6. Build order (incremental — each step shippable)

Tracked as checkboxes under **Epics → Autonome missioner** in [BACKLOG.md](BACKLOG.md):

1. **Schema**: `missions` + `backlog_items`; `BacklogStore` interface (core) + Postgres impl.
2. **Verifier**: wrap `run_check` as `Verifier`; "done" = checks pass (prove it fails on failing tests).
3. **WorkRunner**: run one item through the project/team graph, checkpointed by item id.
4. **Controller loop** (`runMission`): single iteration → full loop, with checkpoint + resume.
5. **Replan agent** (lead): goal + result + verification → update backlog (close / follow-ups / block / risk).
6. **Governors**: budget/deadline/iterations/no-progress/thrash + kill switch.
7. **Human policy**: risk parking + async decision endpoint + `Notifier` (dashboard/log first).
8. **Mission API + PM2 worker**, then the **mission dashboard** (backlog board, live activity, budget burn, parked items, digest).

---

## 7. Out of scope (for now) & open questions

**Out of scope:** multiple concurrent missions on the same repo (serialize); cross-
mission learning / global skill memory; the engine self-modifying its own code; real
Slack/email transport (stub `Notifier` first).

**Still open:** mission as a mode on a project vs its own entity (leaning: own
`missions` row linked to a project); default budgets/deadline for an overnight run;
parallelism within a mission (serial first, worktrees later); how aggressively the
replan agent self-challenges vs. sticks to the goal.

---

## 8. Acceptance criteria

**Shipped (tasks):** `turbo build` green across all packages incl. `apps/web`; all
four graphs run behind the bearer-guarded API and persist/resume via the Postgres
checkpointer; team decomposes→executes→synthesizes; router picks single/team; project
tasks retrieve-then-persist memory; repo runs stay read-only within
`REPO_ALLOWED_ROOTS`; `packages/core` has zero framework/transport deps.

**Directional (missions):** a mission decomposes a goal into a backlog and works items
without a blocking gate; an item closes only when real checks pass (a failing build
keeps it open and feeds the next replan); high-risk items are parked and the mission
continues; governors provably stop it (budget/deadline/iterations/no-progress), each
with a recorded reason; a mission survives a restart and resumes; `POST /missions/:id/stop`
halts at the next checkpoint; core stays pure (all mission I/O injected); a digest
summarises done/parked/spend/next.

---

## 9. Origin / history

v1 was a single **builder↔critic** CLI loop (rubric pass or `MAX_ROUNDS`, human gate),
core-pure from day one for Ranky reuse. **Phase 2** added the NestJS HTTP service +
typed client. **Phase 3** added the multi-agent team, the adaptive project graph,
pgvector project memory, repo tools, and the Next.js dashboard. **Phase 4** (§5) is
the autonomous-missions direction. The original phased briefs are merged into this doc.

---

## 10. Env vars

```
LLM_PROVIDER=mistral|anthropic|google # default provider; + MISTRAL_API_KEY / ANTHROPIC_API_KEY / GOOGLE_API_KEY
GOOGLE_CLOUD_PROJECT= / GOOGLE_CLOUD_LOCATION=europe-west4 # Gemini via Vertex AI + ADC (no API key); set project to use it
LLM_MODEL=                            # optional explicit default model id
LLM_ROLE_MODELS=                      # JSON role→{provider,model?}: per-role "team member" models (§3.8)
SUPABASE_DB_URL=                      # Postgres + pgvector → checkpointer + memory + missions
SUPABASE_URL= / SUPABASE_SERVICE_KEY=
MAX_ROUNDS=3
RUN_TOKEN_BUDGET=                     # per-run cap → run fails if exceeded
RUN_TIMEOUT_MS=300000                 # per-run hard timeout
REPO_ALLOWED_ROOTS=                   # absolute roots repo/mission work is confined to
REPO_ALLOWED_CHECKS=test,lint,typecheck,build
AGENT_API_KEY=                        # ≥16 chars; required by every API route
API_PORT=8787
API_CORS_ORIGINS=                     # exact Ranky/Bravy origins
LANGSMITH_TRACING=false               # + LANGSMITH_API_KEY if enabled
# missions:
MISSION_TOKEN_BUDGET=                 # hard token/cost ceiling per mission
MISSION_DEADLINE_HHMM=07:00           # optional wall-clock stop
MISSION_MAX_ITERATIONS=               # backstop iteration cap
MISSION_NOPROGRESS_LIMIT=3            # consecutive no-progress iterations before stopping
MISSION_HIGH_RISK_PATTERNS=           # extra patterns forcing risk=high (deploy, drop, delete …)
MISSION_CONCURRENCY=1                 # items run in parallel per mission (integration stays serial)
MISSION_REVIEW_ROUNDS=1              # ★ critic↔implementer revision cycles per item (0 = lone implementer)
MISSION_AUTHOR_TESTS=false          # Trin 2: author a test exercising each item before verify (green = strong truth)
MISSION_LLM_MAX_RETRIES=6           # Trin 3: transient-error retries per model call (exp backoff + jitter)
MISSION_REQUEUE_LIMIT=2             # Trin 3: re-queues of a transiently-failing item before parking it
# overnight trust (nordstjerne-gap, 2026-06-24):
MISSION_NOTIFY_WEBHOOK_URL=        # blocker 1: out-of-band webhook (Slack/Discord/Mattermost/custom) for parked/digest/stopped
MISSION_DIGEST_INTERVAL_MS=        # blocker 1: push a mid-run digest this often (ms, min 60000); empty = only at end
MISSION_ABORT_POLL_MS=3000         # blocker 2: how often the worker re-reads status/deadline/budget to abort in-flight work
MISSION_MAX_STRATEGIC_REPLANS=3    # blocker 3: strategic re-decompose rounds when the backlog drains (0 = drain-and-stop)
```

> **As-built (nordstjerne-gap closed, 2026-06-24):** four blockers between "M3 ticked"
> and "trust it unattended overnight", found by auditing the code (not the checkboxes),
> are now closed. (1) **Out-of-band notification** — `createWebhookNotifier` (shared)
> POSTs the human-actionable events to a webhook via the Notifier's `also` fan-out,
> plus a scheduled mid-run digest, so a sleeping overseer is actually reachable.
> (2) **Preemptive stop** — the worker builds an `AbortController` + a watcher that
> aborts the in-flight run the moment the kill switch / deadline / budget trips; core
> gained a clean `aborted` outcome that re-queues the item (never a false park).
> (3) **Strategic self-direction** — when the backlog drains the controller re-invokes
> the `Decomposer` with `continuation:true` (goal + everything attempted) for the next
> slice, converging on an empty re-plan; bounded by `MISSION_MAX_STRATEGIC_REPLANS`.
> (4) **Durable termination** — `iterations`/`no_progress` persist on the mission row,
> so a thrashing mission can't re-earn its budget on every PM2 restart. *Proven:*
> [verify-blockers.ts](../packages/core/verify-blockers.ts) +
> [verify-notifier.ts](../packages/shared/verify-notifier.ts) (hermetic), with
> [smoke-mission-full.ts](../packages/core/smoke-mission-full.ts) as the live full-stack run.
