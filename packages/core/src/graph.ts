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
import { makeBuilderNode } from "./nodes/builder.js";
import { makeCriticNode } from "./nodes/critic.js";
import { humanGateNode, markAwaitingHuman } from "./nodes/humanGate.js";
import { defaultRubric, type Rubric } from "./rubric.js";
import { GraphState, type GraphStateType } from "./state.js";

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
    .addEdge("humanGate", END)
    .addEdge("fail", END)
    .compile({ checkpointer: options.checkpointer });
}

export type AgentGraph = ReturnType<typeof createAgentGraph>;
