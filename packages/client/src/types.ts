/**
 * Wire types for the agent-engine HTTP API.
 * Single source of truth — `apps/api` imports these so the service and the
 * client can never drift apart.
 */

export type ApiRunStatus =
  | "running"
  | "awaiting_human"
  | "accepted"
  | "rejected"
  | "failed";

export interface ApiVerdict {
  pass: boolean;
  score: number;
  issues: string[];
}

export interface ApiMessage {
  agent: "builder" | "critic" | "human" | "system";
  role: "assistant" | "user" | "system";
  content: string;
}

export interface StartRunRequest {
  task: string;
  rubricId?: string;
  options?: { maxRounds?: number };
}

export interface StartRunResponse {
  runId: string;
  threadId: string;
  status: "running";
}

export interface RunDetail {
  runId: string;
  threadId: string;
  status: ApiRunStatus;
  round: number;
  draft: string;
  verdict: ApiVerdict | null;
  messages: ApiMessage[];
}

export interface RunSummary {
  runId: string;
  task: string;
  status: ApiRunStatus;
  createdAt: string;
}

export interface DecisionRequest {
  decision: "approve" | "reject";
  notes?: string;
}

export interface DecisionResponse {
  runId: string;
  status: ApiRunStatus;
}

export type RunEvent =
  | { type: "node"; node: "builder" | "critic"; round: number; content: string }
  | { type: "verdict"; round: number; pass: boolean; score: number; issues: string[] }
  | { type: "awaiting_human"; runId: string }
  | { type: "done"; status: ApiRunStatus; result: { draft: string; verdict: ApiVerdict | null } }
  | { type: "error"; message: string };
