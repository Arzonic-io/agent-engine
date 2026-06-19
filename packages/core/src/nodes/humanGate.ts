import { interrupt } from "@langchain/langgraph";
import type { GraphStateType } from "../state.js";

export interface HumanGatePayload {
  type: "human_approval";
  draft: string;
  verdict: GraphStateType["verdict"];
  round: number;
  note: string;
}

export type HumanDecision = "approve" | "reject" | "revise";

/** What the runtime resumes the interrupt with. A bare string is still accepted (CLI). */
export interface HumanResume {
  decision: HumanDecision;
  notes?: string;
}

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

  const resume = interrupt(payload) as HumanResume | HumanDecision;
  const decision: HumanDecision = typeof resume === "string" ? resume : resume.decision;
  const notes = typeof resume === "string" ? "" : (resume.notes ?? "").trim();

  if (decision === "approve") {
    return {
      status: "accepted",
      humanNotes: notes,
      messages: [
        {
          agent: "human",
          role: "user",
          content: notes
            ? `Approved final draft. Reviewer notes: ${notes}`
            : "Approved final draft.",
        },
      ],
    };
  }

  if (decision === "revise") {
    // Loop back to the builder with the human's notes as guidance.
    return {
      status: "running",
      humanNotes: notes,
      messages: [
        {
          agent: "human",
          role: "user",
          content: notes
            ? `Requested a revision with notes: ${notes}`
            : "Requested another revision.",
        },
      ],
    };
  }

  return {
    status: "failed",
    messages: [
      {
        agent: "human",
        role: "user",
        content: notes ? `Rejected final draft. Notes: ${notes}` : "Rejected final draft.",
      },
    ],
  };
}
