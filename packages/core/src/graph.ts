import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  END,
  START,
  StateGraph,
  type BaseCheckpointSaver,
} from "@langchain/langgraph";
import {
  DEFAULT_GUARDRAILS,
  isBudgetExceeded,
  type GuardrailConfig,
} from "./guardrails.js";
import { makeAnalystNode } from "./nodes/analyst.js";
import { makeArchitectNode } from "./nodes/architect.js";
import { makeBuilderNode } from "./nodes/builder.js";
import { makeCriticNode } from "./nodes/critic.js";
import { makeImplementerNode } from "./nodes/implementer.js";
import { humanGateNode, markAwaitingHuman } from "./nodes/humanGate.js";
import { makeLeadNode } from "./nodes/lead.js";
import { makePersistMemoryNode } from "./nodes/persistMemory.js";
import { makeRetrieveContextNode } from "./nodes/retrieveContext.js";
import { makeRouterNode } from "./nodes/router.js";
import { makeWorkerNode } from "./nodes/worker.js";
import type { ProjectMemory } from "./memory.js";
import { defaultRubric, type Rubric } from "./rubric.js";
import { GraphState, type GraphStateType } from "./state.js";
import type { RepoTools, WritableRepoTools } from "./tools.js";

export interface CreateAgentGraphOptions {
  model: BaseChatModel;
  rubric?: Rubric;
  guardrails?: GuardrailConfig;
  /**
   * Injected by the runtime (CLI now, API later). Core never owns persistence —
   * that keeps this package importable anywhere, including Next.js.
   */
  checkpointer: BaseCheckpointSaver;
}

export function createAgentGraph(options: CreateAgentGraphOptions) {
  const rubric = options.rubric ?? defaultRubric;
  const guardrails = options.guardrails ?? DEFAULT_GUARDRAILS;

  const failNode = async (
    state: GraphStateType,
  ): Promise<Partial<GraphStateType>> => ({
    status: "failed",
    messages: [
      {
        agent: "system" as const,
        role: "system" as const,
        content: `Run aborted: token budget exceeded (${state.tokensUsed} tokens used).`,
      },
    ],
  });

  const afterBuilder = (state: GraphStateType): "critic" | "fail" =>
    isBudgetExceeded(state.tokensUsed, guardrails) ? "fail" : "critic";

  const afterCritic = (
    state: GraphStateType,
  ): "markAwaitingHuman" | "builder" | "fail" => {
    if (isBudgetExceeded(state.tokensUsed, guardrails)) return "fail";
    if (state.verdict?.pass) return "markAwaitingHuman";
    if (state.round >= guardrails.maxRounds) return "markAwaitingHuman";
    return "builder";
  };

  return new StateGraph(GraphState)
    .addNode("builder", makeBuilderNode(options.model))
    .addNode("critic", makeCriticNode(options.model, rubric))
    .addNode("markAwaitingHuman", markAwaitingHuman)
    .addNode("humanGate", humanGateNode)
    .addNode("fail", failNode)
    .addEdge(START, "builder")
    .addConditionalEdges("builder", afterBuilder, ["critic", "fail"])
    .addConditionalEdges("critic", afterCritic, [
      "markAwaitingHuman",
      "builder",
      "fail",
    ])
    .addEdge("markAwaitingHuman", "humanGate")
    .addConditionalEdges("humanGate", afterGate, ["builder", END])
    .addEdge("fail", END)
    .compile({ checkpointer: options.checkpointer });
}

/** After the gate: a 'revise' decision sets status=running and loops to the builder; otherwise END. */
function afterGate(state: GraphStateType): "builder" | typeof END {
  return state.status === "running" ? "builder" : END;
}

export type AgentGraph = ReturnType<typeof createAgentGraph>;

export interface CreateImplementerGraphOptions {
  model: BaseChatModel;
  /** Write-capable repo tools rooted at the item's worktree, injected by the runtime. */
  repo: WritableRepoTools;
  checkpointer: BaseCheckpointSaver;
}

/**
 * Mission execution graph (M2 build-order Trin 4): a single write-capable
 * implementer node that authors real code in a worktree. No human gate —
 * missions never block; the Verifier (real checks) decides "done". One graph is
 * compiled per item, rooted at that item's worktree via the injected
 * `WritableRepoTools`.
 */
export function createImplementerGraph(options: CreateImplementerGraphOptions) {
  return new StateGraph(GraphState)
    .addNode("implementer", makeImplementerNode(options.model, options.repo))
    .addEdge(START, "implementer")
    .addEdge("implementer", END)
    .compile({ checkpointer: options.checkpointer });
}

export type ImplementerGraph = ReturnType<typeof createImplementerGraph>;

export interface CreateRepoAnalysisGraphOptions {
  model: BaseChatModel;
  /** Read-only repo capabilities, sandboxed + injected by the runtime. */
  tools: RepoTools;
  rubric?: Rubric;
  guardrails?: GuardrailConfig;
  checkpointer: BaseCheckpointSaver;
}

/**
 * Layer 1: a tool-using analyst refines a repo findings report against the
 * critic's rubric. Read-only — no human gate, since nothing is mutated; the run
 * ends as soon as the rubric passes or MAX_ROUNDS is hit.
 */
export function createRepoAnalysisGraph(options: CreateRepoAnalysisGraphOptions) {
  const rubric = options.rubric ?? defaultRubric;
  const guardrails = options.guardrails ?? DEFAULT_GUARDRAILS;

  const failNode = async (
    state: GraphStateType,
  ): Promise<Partial<GraphStateType>> => ({
    status: "failed",
    messages: [
      {
        agent: "system" as const,
        role: "system" as const,
        content: `Run aborted: token budget exceeded (${state.tokensUsed} tokens used).`,
      },
    ],
  });

  const done = async (
    _state: GraphStateType,
  ): Promise<Partial<GraphStateType>> => ({ status: "accepted" });

  const afterAnalyst = (state: GraphStateType): "critic" | "fail" =>
    isBudgetExceeded(state.tokensUsed, guardrails) ? "fail" : "critic";

  const afterCritic = (
    state: GraphStateType,
  ): "done" | "analyst" | "fail" => {
    if (isBudgetExceeded(state.tokensUsed, guardrails)) return "fail";
    if (state.verdict?.pass) return "done";
    if (state.round >= guardrails.maxRounds) return "done";
    return "analyst";
  };

  return new StateGraph(GraphState)
    .addNode("analyst", makeAnalystNode(options.model, options.tools))
    .addNode("critic", makeCriticNode(options.model, rubric))
    .addNode("done", done)
    .addNode("fail", failNode)
    .addEdge(START, "analyst")
    .addConditionalEdges("analyst", afterAnalyst, ["critic", "fail"])
    .addConditionalEdges("critic", afterCritic, ["done", "analyst", "fail"])
    .addEdge("done", END)
    .addEdge("fail", END)
    .compile({ checkpointer: options.checkpointer });
}

export type RepoAnalysisGraph = ReturnType<typeof createRepoAnalysisGraph>;

export interface CreateTeamGraphOptions {
  model: BaseChatModel;
  rubric?: Rubric;
  guardrails?: GuardrailConfig;
  checkpointer: BaseCheckpointSaver;
}

/**
 * Phase C — the multi-agent team:
 *   architect (plans) → worker ×N (one per step) → lead (synthesizes)
 *   → critic (challenges) ↔ lead (revises) → human gate.
 *
 * Two bounded loops keep it terminating: the worker loop runs exactly
 * `plan.length` times; the lead↔critic loop is capped by MAX_ROUNDS.
 */
export function createTeamGraph(options: CreateTeamGraphOptions) {
  const rubric = options.rubric ?? defaultRubric;
  const guardrails = options.guardrails ?? DEFAULT_GUARDRAILS;

  const failNode = async (
    state: GraphStateType,
  ): Promise<Partial<GraphStateType>> => ({
    status: "failed",
    messages: [
      {
        agent: "system" as const,
        role: "system" as const,
        content: `Run aborted: token budget exceeded (${state.tokensUsed} tokens used).`,
      },
    ],
  });

  const advance = async (
    state: GraphStateType,
  ): Promise<Partial<GraphStateType>> => ({ currentStep: state.currentStep + 1 });

  const afterWorker = (state: GraphStateType): "advance" | "fail" =>
    isBudgetExceeded(state.tokensUsed, guardrails) ? "fail" : "advance";

  const afterAdvance = (state: GraphStateType): "worker" | "lead" =>
    state.currentStep < state.plan.length ? "worker" : "lead";

  const afterLead = (state: GraphStateType): "critic" | "fail" =>
    isBudgetExceeded(state.tokensUsed, guardrails) ? "fail" : "critic";

  const afterCritic = (
    state: GraphStateType,
  ): "markAwaitingHuman" | "lead" | "fail" => {
    if (isBudgetExceeded(state.tokensUsed, guardrails)) return "fail";
    if (state.verdict?.pass) return "markAwaitingHuman";
    if (state.round >= guardrails.maxRounds) return "markAwaitingHuman";
    return "lead";
  };

  const afterGate = (state: GraphStateType): "lead" | typeof END =>
    state.status === "running" ? "lead" : END;

  return new StateGraph(GraphState)
    .addNode("architect", makeArchitectNode(options.model))
    .addNode("worker", makeWorkerNode(options.model))
    .addNode("advance", advance)
    .addNode("lead", makeLeadNode(options.model))
    .addNode("critic", makeCriticNode(options.model, rubric))
    .addNode("markAwaitingHuman", markAwaitingHuman)
    .addNode("humanGate", humanGateNode)
    .addNode("fail", failNode)
    .addEdge(START, "architect")
    .addEdge("architect", "worker")
    .addConditionalEdges("worker", afterWorker, ["advance", "fail"])
    .addConditionalEdges("advance", afterAdvance, ["worker", "lead"])
    .addConditionalEdges("lead", afterLead, ["critic", "fail"])
    .addConditionalEdges("critic", afterCritic, ["markAwaitingHuman", "lead", "fail"])
    .addEdge("markAwaitingHuman", "humanGate")
    .addConditionalEdges("humanGate", afterGate, ["lead", END])
    .addEdge("fail", END)
    .compile({ checkpointer: options.checkpointer });
}

export type TeamGraph = ReturnType<typeof createTeamGraph>;

export interface CreateProjectGraphOptions {
  model: BaseChatModel;
  /** Injected pgvector-backed project memory (retrieve before / persist after). */
  memory: ProjectMemory;
  rubric?: Rubric;
  guardrails?: GuardrailConfig;
  checkpointer: BaseCheckpointSaver;
}

/**
 * Phase 3 — the persistent project team. One graph, adaptive topology:
 *   retrieveContext → router → { single: builder↔critic | team: architect→worker→lead↔critic }
 *   → human gate → (on approve) persistMemory.
 * Reuses every existing node; the router (not the user) picks single vs team.
 */
export function createProjectGraph(options: CreateProjectGraphOptions) {
  const rubric = options.rubric ?? defaultRubric;
  const guardrails = options.guardrails ?? DEFAULT_GUARDRAILS;
  const { model, memory } = options;

  const failNode = async (
    state: GraphStateType,
  ): Promise<Partial<GraphStateType>> => ({
    status: "failed",
    messages: [
      {
        agent: "system" as const,
        role: "system" as const,
        content: `Run aborted: token budget exceeded (${state.tokensUsed} tokens used).`,
      },
    ],
  });

  const advance = async (
    state: GraphStateType,
  ): Promise<Partial<GraphStateType>> => ({ currentStep: state.currentStep + 1 });

  const afterRouter = (state: GraphStateType): "architect" | "builder" =>
    state.topology === "team" ? "architect" : "builder";

  const afterBuilder = (state: GraphStateType): "critic" | "fail" =>
    isBudgetExceeded(state.tokensUsed, guardrails) ? "fail" : "critic";

  const afterWorker = (state: GraphStateType): "advance" | "fail" =>
    isBudgetExceeded(state.tokensUsed, guardrails) ? "fail" : "advance";

  const afterAdvance = (state: GraphStateType): "worker" | "lead" =>
    state.currentStep < state.plan.length ? "worker" : "lead";

  const afterLead = (state: GraphStateType): "critic" | "fail" =>
    isBudgetExceeded(state.tokensUsed, guardrails) ? "fail" : "critic";

  // Shared critic: retry routes back to the path the router picked.
  const afterCritic = (
    state: GraphStateType,
  ): "markAwaitingHuman" | "builder" | "lead" | "fail" => {
    if (isBudgetExceeded(state.tokensUsed, guardrails)) return "fail";
    if (state.verdict?.pass) return "markAwaitingHuman";
    if (state.round >= guardrails.maxRounds) return "markAwaitingHuman";
    return state.topology === "team" ? "lead" : "builder";
  };

  const afterGate = (
    state: GraphStateType,
  ): "persistMemory" | "builder" | "lead" | typeof END => {
    if (state.status === "accepted") return "persistMemory";
    if (state.status === "running") return state.topology === "team" ? "lead" : "builder";
    return END; // rejected / failed
  };

  return new StateGraph(GraphState)
    .addNode("retrieveContext", makeRetrieveContextNode(memory))
    .addNode("router", makeRouterNode(model))
    .addNode("builder", makeBuilderNode(model))
    .addNode("architect", makeArchitectNode(model))
    .addNode("worker", makeWorkerNode(model))
    .addNode("advance", advance)
    .addNode("lead", makeLeadNode(model))
    .addNode("critic", makeCriticNode(model, rubric))
    .addNode("markAwaitingHuman", markAwaitingHuman)
    .addNode("humanGate", humanGateNode)
    .addNode("persistMemory", makePersistMemoryNode(memory))
    .addNode("fail", failNode)
    .addEdge(START, "retrieveContext")
    .addEdge("retrieveContext", "router")
    .addConditionalEdges("router", afterRouter, ["architect", "builder"])
    .addConditionalEdges("builder", afterBuilder, ["critic", "fail"])
    .addEdge("architect", "worker")
    .addConditionalEdges("worker", afterWorker, ["advance", "fail"])
    .addConditionalEdges("advance", afterAdvance, ["worker", "lead"])
    .addConditionalEdges("lead", afterLead, ["critic", "fail"])
    .addConditionalEdges("critic", afterCritic, ["markAwaitingHuman", "builder", "lead", "fail"])
    .addEdge("markAwaitingHuman", "humanGate")
    .addConditionalEdges("humanGate", afterGate, ["persistMemory", "builder", "lead", END])
    .addEdge("persistMemory", END)
    .addEdge("fail", END)
    .compile({ checkpointer: options.checkpointer });
}

export type ProjectGraph = ReturnType<typeof createProjectGraph>;
