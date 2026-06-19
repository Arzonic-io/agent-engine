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

export interface ApiCriterion {
  id: string;
  label: string;
  met: boolean;
  required: boolean;
}

export interface ApiVerdict {
  pass: boolean;
  score: number;
  issues: string[];
  criteria?: ApiCriterion[];
}

export type AgentRole =
  | "builder"
  | "critic"
  | "human"
  | "system"
  | "analyst"
  | "architect"
  | "lead"
  | "worker"
  | "implementer";

export interface ApiMessage {
  agent: AgentRole;
  role: "assistant" | "user" | "system";
  content: string;
}

export interface StartRunRequest {
  task: string;
  rubricId?: string;
  mode?: "single" | "team";
  repoPath?: string;
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
  task: string;
  status: ApiRunStatus;
  round: number;
  tokensUsed: number;
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

export interface RepoInfo {
  name: string;
  path: string;
}

/** Rollups the composer shows alongside a project. */
export interface ProjectStats {
  /** Remembered items — non-brief project_memory rows. */
  memoryCount: number;
  taskCount: number;
  /** ISO timestamp of the most recent task, or null if none yet. */
  lastTaskAt: string | null;
}

export interface Project {
  id: string;
  name: string;
  brief: string;
  settings: Record<string, unknown>;
  createdAt: string;
  /** Present on the list endpoint; absent on create/get. */
  stats?: ProjectStats;
}

/** A task within a project, as returned by `GET /projects/:id/tasks`. */
export interface ProjectTask {
  id: string;
  projectId: string;
  task: string;
  topology: "single" | "team" | null;
  status: ApiRunStatus | string;
  createdAt: string;
}

/** A task tagged with its project name, as returned by `GET /tasks`. */
export interface RecentTask {
  id: string;
  projectId: string;
  projectName: string;
  task: string;
  topology: "single" | "team" | null;
  status: ApiRunStatus | string;
  createdAt: string;
}

export interface RubricCriterion {
  id: string;
  description: string;
  required: boolean;
}

export interface Rubric {
  criteria: RubricCriterion[];
  passThreshold: number;
}

export interface DecisionRequest {
  decision: "approve" | "reject" | "revise";
  notes?: string;
}

export interface DecisionResponse {
  runId: string;
  status: ApiRunStatus;
}

// ── autonomous missions (§5) ──

export type MissionStatus =
  | "running"
  | "paused"
  | "blocked"
  | "done"
  | "failed"
  | "stopped";

export type BacklogItemStatus =
  | "todo"
  | "in_progress"
  | "done"
  | "blocked_needs_human"
  | "failed";

export type Risk = "low" | "high";

export interface ApiVerification {
  passed: boolean;
  check: string;
  output: string;
}

export interface ApiBacklogItem {
  id: string;
  missionId: string;
  title: string;
  detail: string;
  status: BacklogItemStatus;
  priority: number;
  dependsOn: string[];
  risk: Risk;
  runId: string | null;
  verification: ApiVerification | null;
  createdAt: string;
  updatedAt: string;
}

/** A team member's model assignment. anthropic = Claude, google = Gemini. */
export type ModelProvider = "mistral" | "anthropic" | "google";
export interface ModelSpec {
  provider: ModelProvider;
  /** Explicit model id; omitted = the provider's default. */
  model?: string;
}
/** Per-role model choices: role name → spec. Roles: architect, worker, lead, critic, builder, implementer, analyst, router, replan, decompose. */
export type RoleModelsConfig = Record<string, ModelSpec>;

export interface MissionSummary {
  id: string;
  projectId: string;
  goal: string;
  acceptanceCriteria: string[];
  repoPath: string;
  status: MissionStatus;
  budget: number | null;
  spentTokens: number;
  deadline: string | null;
  /** Per-mission team config — which provider/model each role uses for this mission. */
  roleModels: RoleModelsConfig;
  createdAt: string;
}

/** Done/parked/failed/next rollup — the morning digest (§5.5). */
export interface MissionDigest {
  missionId: string;
  goal: string;
  status: MissionStatus;
  spentTokens: number;
  done: string[];
  parked: string[];
  failed: string[];
  pending: number;
  next: string[];
}

export interface MissionDetail extends MissionSummary {
  items: ApiBacklogItem[];
  digest: MissionDigest;
}

export interface NewBacklogItem {
  title: string;
  detail?: string;
  priority?: number;
  dependsOn?: string[];
  risk?: Risk;
}

export interface CreateMissionRequest {
  projectId: string;
  goal: string;
  repoPath: string;
  acceptanceCriteria?: string[];
  budget?: number | null;
  /** ISO wall-clock deadline. */
  deadline?: string | null;
  /** Optional initial backlog to seed the mission with. */
  items?: NewBacklogItem[];
  /** Optional per-mission team config: role → { provider, model? }. Inherits global default if omitted. */
  roleModels?: RoleModelsConfig;
}

/** Async approve/reject of a parked (high-risk or thrashing) item (§5.5). */
export interface MissionItemDecisionRequest {
  decision: "approve" | "reject";
}

export interface MissionItemDecisionResponse {
  itemId: string;
  status: BacklogItemStatus;
}

export interface StopMissionResponse {
  missionId: string;
  status: MissionStatus;
}

/** SSE frame from `GET /missions/:id/stream` — a periodic state snapshot. */
export type MissionStreamEvent =
  | { type: "snapshot"; mission: MissionSummary; items: ApiBacklogItem[]; digest: MissionDigest }
  | { type: "error"; message: string };

export type RunEvent =
  | { type: "token"; node: "builder" | "analyst"; content: string }
  | {
      type: "node";
      node:
        | "builder"
        | "critic"
        | "analyst"
        | "architect"
        | "lead"
        | "worker"
        | "system";
      round: number;
      content: string;
      tokens?: number;
    }
  | {
      type: "verdict";
      round: number;
      pass: boolean;
      score: number;
      issues: string[];
      criteria?: ApiCriterion[];
      tokens?: number;
    }
  | { type: "awaiting_human"; runId: string }
  | { type: "done"; status: ApiRunStatus; result: { draft: string; verdict: ApiVerdict | null } }
  | { type: "error"; message: string };
