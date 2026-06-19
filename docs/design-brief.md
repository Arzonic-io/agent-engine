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
router, replan, decompose`.

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
- **Team** (architect → workers → lead → critic) — *the target* executor for each item.
- **Tester/Verifier** — runs the real checks; its result, not the LLM, decides "done".

> **As-built note (be honest):** today a mission item is executed by a **single
> write-capable implementer node** (`createImplementerGraph`), not the full team —
> the collaborate-and-challenge team graph is currently wired only into the bounded
> *task* path. So a mission's quality bar is "one implementer pass + Verifier +
> Replanner", which catches *red* builds but not *green-but-wrong* work. Wiring the
> team (or at least a critic/lead review pass) into the mission `WorkRunner` is the
> key open correctness step — now unblocked by per-role models (§3.8), so the
> mission critic can be a cheap Gemini while the implementer is Claude. Tracked in
> [BACKLOG.md](BACKLOG.md) under M3.

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
```
