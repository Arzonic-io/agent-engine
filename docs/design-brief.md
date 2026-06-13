# Design Brief - Agent Engine

Hand-off spec for Claude Code. Build exactly what is described, follow the non-negotiables, and stop at the v1 acceptance criteria. Anything under "Out of scope (v1)" must NOT be built yet.

## 1. Purpose

Agent Engine is an internal multi-agent engine for Arzonic. A small team of role-based agents collaborate and challenge each other to produce higher-quality output, with a human approval gate before anything is accepted.

v1 ships the smallest useful version: a builder ↔ critic loop that refines a single task until a rubric passes or a round limit is hit, runnable from a CLI.

The engine `core` must be portable - it will later be lifted into the Ranky product to power a customer-facing assistant. Design for that from day one.

## 2. Non-negotiables (constraints)

- TypeScript everywhere.
- LangGraph.js (`@langchain/langgraph`) is the orchestration engine.
- `packages/core` is pure TS, framework-free - no Nest, no HTTP, no transport. This is the reuse contract with Ranky. If it can't be imported into a Next.js app untouched, it's wrong.
- Nest is NOT used in v1. It only ever lives in `apps/api` later.
- v1 runs as a CLI, no server.
- State + checkpoints persist in Supabase (EU) - but start with the built-in in-memory saver and swap to Supabase last (see build order).
- Hard guardrails: max rounds, token/cost budget, timeout. The loop must be provably terminating.
- Human-in-the-loop: a gate before final "accepted" status.
- Deployable as a plain Node process under PM2 on a VPS.
- No secrets in code - everything via env.

## 3. Repo structure (Turborepo, pnpm)

```
agent-engine/
  packages/
    core/            # graph, nodes (agents), state schema, tools, rubric/DoD. Pure TS.
    shared/          # env loading, supabase client, llm client factory, shared types
  apps/
    cli/             # v1 entrypoint: run the graph on one task (tsx)
  package.json
  pnpm-workspace.yaml
  turbo.json
  tsconfig.base.json
```

Package scopes: `@arzonic/agent-core`, `@arzonic/agent-shared`, `@arzonic/agent-cli`. (Scoped under `@arzonic` so packages are reusable across Arzonic repos.)

Do not create empty packages "for later". Only `core`, `shared`, `cli` in v1.

## 4. Tech stack

- pnpm workspaces + Turborepo
- TypeScript (strict)
- `@langchain/langgraph` (graph + in-memory `MemorySaver`)
- `@langchain/langgraph-checkpoint-postgres` (Supabase/Postgres saver - added last)
- `@langchain/core`
- LLM provider: configurable. Default EU-friendly option `@langchain/mistralai` (`ChatMistralAI`); also support `@langchain/anthropic` (`ChatAnthropic`). Selected via `LLM_PROVIDER` env.
- `zod` for state + structured-output schemas
- `@supabase/supabase-js`
- `tsx` to run the CLI
- LangSmith tracing - optional, enabled by env only

Verify current package versions before installing; pin them in package.json.

## 5. Core design (`packages/core`)

### State (zod schema)

- `task: string` - the input request
- `messages: AgentMessage[]` - running transcript (agent, role, content)
- `draft: string` - current builder output
- `round: number`
- `verdict: { pass: boolean; score: number; issues: string[] } | null`
- `status: 'running' | 'awaiting_human' | 'accepted' | 'failed'`

### Nodes

- `builderNode` - produces/revises `draft` from `task` + latest critic `issues`.
- `criticNode` - evaluates `draft` against a rubric / Definition of Done and returns a structured `verdict` (zod-validated). The critic must be prompted to find concrete problems, not to approve by default.

### Rubric / Definition of Done

A small, explicit, configurable checklist the critic scores against (e.g. correctness, completeness, matches task, no obvious security/edge-case gaps). Pass = all required criteria met AND `score >= threshold`. This is 80% of output quality - make it a first-class, easily-editable config object, not buried in a prompt string.

### Graph

```
START → builder → critic → [conditional edge]
   conditional edge:
     pass === true            → humanGate
     round >= MAX_ROUNDS      → humanGate (status: needs review)
     else                     → builder   (increment round)
humanGate → END   (interrupt for human approve/reject; on approve status=accepted)
```

### Guardrails

- `MAX_ROUNDS` (default 3) - hard stop.
- Token/cost budget per run - abort + mark failed if exceeded.
- Per-run timeout.

### Checkpointer

- v1: `MemorySaver`.
- Then swap to a Supabase/Postgres-backed saver so runs persist and resume.

## 6. Runtime (`apps/cli`)

- Command: `pnpm agent "<task>"`
- Behaviour: starts one thread, streams each node step to stdout, prints the final draft + verdict + full transcript. On `awaiting_human`, prompt in the terminal to approve/reject, then resume.
- All config (API keys, Supabase, limits, provider) from env via `@arzonic/agent-shared`.

## 7. Out of scope (v1) - note only, do NOT build

- `apps/api` (NestJS): HTTP, Slack/Mattermost webhooks, BullMQ workers, dashboard.
- Extra agents: architect, lead/orchestrator.
- Promoting `core` into the Ranky repo.

## 8. Acceptance criteria (definition of done for v1)

1. `turbo build` succeeds across the workspace.
2. `pnpm agent "build X"` runs the builder ↔ critic loop and terminates by either rubric pass or `MAX_ROUNDS`.
3. Output: final draft, structured verdict, and full transcript printed.
4. `packages/core` has zero framework/transport/HTTP dependencies.
5. Human gate works: run pauses, human approves/rejects, status updates.
6. Checkpointer persists a run; an interrupted run can be resumed.
7. All config env-driven; no hardcoded secrets.

## 9. Env vars

```
LLM_PROVIDER=mistral            # mistral | anthropic
MISTRAL_API_KEY=
ANTHROPIC_API_KEY=
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
MAX_ROUNDS=3
RUN_TOKEN_BUDGET=               # optional cap
LANGSMITH_TRACING=false
LANGSMITH_API_KEY=              # only if tracing
```

## 10. Build order for Claude Code

1. Init pnpm + Turborepo; create `tsconfig.base.json`, `turbo.json`, `pnpm-workspace.yaml`. Add `packages/core`, `packages/shared`, `apps/cli`.
2. `shared`: env loader (zod-validated), supabase client, `getModel()` factory selecting provider from `LLM_PROVIDER`.
3. `core`: state schema → builder/critic nodes → rubric config → graph with conditional edge + human gate → guardrails. Use `MemorySaver` first.
4. `cli`: entrypoint invoking the graph, streaming steps, handling the human gate.
5. Verify acceptance criteria 1–5 with `MemorySaver`.
6. Swap checkpointer to the Supabase/Postgres saver; verify criteria 6–7.
7. Write a short README: how to run, env setup, how to edit the rubric, and where the architect/lead agents will slot in later.
