import { interrupt } from "@langchain/langgraph";
import type { GraphStateType } from "../state.js";

export interface HumanGatePayload {
  type: "human_approval";
  draft: string;
  verdict: GraphStateType["verdict"];
  round: number;
  note: string;
}

export type HumanDecision = "approve" | "reject";

/**
 * Runs just before the interrupt so the persisted checkpoint carries
 * status=awaiting_human while the run is paused.
 */
export async function markAwaitingHuman(
  state: GraphStateType,
): Promise<Partial<GraphStateType>> {
  return {
    status: "awaiting_human",
    messages: [
      {
        agent: "system",
        role: "system",
        content: state.verdict?.pass
          ? "Rubric passed — awaiting human approval."
          : "Round limit reached without rubric pass — awaiting human review.",
      },
    ],
  };
}

export async function humanGateNode(
  state: GraphStateType,
): Promise<Partial<GraphStateType>> {
  const payload: HumanGatePayload = {
    type: "human_approval",
    draft: state.draft,
    verdict: state.verdict,
    round: state.round,
    note: state.verdict?.pass
      ? "Rubric passed."
      : "Max rounds reached — needs review.",
  };

  const decision = interrupt(payload) as HumanDecision;

  if (decision === "approve") {
    return {
      status: "accepted",
      messages: [
        { agent: "human", role: "user", content: "Approved final draft." },
      ],
    };
  }
  return {
    status: "failed",
    messages: [
      { agent: "human", role: "user", content: "Rejected final draft." },
    ],
  };
}
