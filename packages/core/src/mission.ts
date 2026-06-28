import { z } from "zod";
import { RoleModelsConfigSchema, type RoleModelsConfig } from "./models.js";

/**
 * Mission domain — the autonomous-missions north star (§5 of the design brief).
 *
 * A mission is a long-running goal the engine works toward by planning its own
 * backlog, executing items through the existing graphs, verifying against a real
 * repo, and re-planning until done or a governor stops it. This file defines the
 * shapes and the `BacklogStore` capability the controller loop needs — as a pure
 * interface. The runtime injects a concrete implementation (the Postgres-backed
 * `BacklogService` in `@arzonic/agent-shared`), keeping `core` framework-free —
 * exactly like `ProjectMemory` and `RepoTools` already are.
 */

/** running → the loop is feeding it work; terminal/parked states stop the loop. */
export const MissionStatusSchema = z.enum([
  "running",
  "paused",
  "blocked",
  "done",
  "failed",
  "stopped",
]);
export type MissionStatus = z.infer<typeof MissionStatusSchema>;

/** Per-item lifecycle. `blocked_needs_human` is the park-risk state (§5.5). */
export const BacklogItemStatusSchema = z.enum([
  "todo",
  "in_progress",
  "done",
  "blocked_needs_human",
  "failed",
]);
export type BacklogItemStatus = z.infer<typeof BacklogItemStatusSchema>;

/** High-risk items (deploys, deletes, payments, secrets) get parked, not auto-applied. */
export const RiskSchema = z.enum(["low", "high"]);
export type Risk = z.infer<typeof RiskSchema>;

/** The Verifier's recorded outcome for an item — the truth source for "done". */
export const VerificationSchema = z.object({
  /** Whether the real checks passed (build/test/lint/typecheck). */
  passed: z.boolean(),
  /** Which check produced this result, e.g. "test" | "build". */
  check: z.string(),
  /** Captured stdout/stderr tail for the digest and the next replan. */
  output: z.string().default(""),
});
export type Verification = z.infer<typeof VerificationSchema>;

/** One changed file in an item's diff — what a human scans before approving (§ M3 Trin 5). */
export const DiffFileSchema = z.object({
  path: z.string(),
  status: z.enum(["added", "modified", "deleted", "renamed"]),
  /** Added lines in this file (0 for binary). */
  additions: z.number().int().min(0),
  /** Removed lines in this file (0 for binary). */
  deletions: z.number().int().min(0),
});
export type DiffFile = z.infer<typeof DiffFileSchema>;

/**
 * The structured diff of the code an item authored — changed files (with ±lines)
 * plus the unified patch — so a human can SEE the change before Godkend/Afvis,
 * especially on parked items (M3 Trin 5). Computed from the item's worktree before
 * integration; the `Differ` seam produces it, the controller stores it on the item.
 */
export const DiffResultSchema = z.object({
  files: z.array(DiffFileSchema),
  /** Total added lines across all files. */
  additions: z.number().int().min(0),
  /** Total removed lines across all files. */
  deletions: z.number().int().min(0),
  /** Unified patch (capped); empty when there are no changes. */
  patch: z.string().default(""),
  /** Whether the patch was truncated to its size cap. */
  truncated: z.boolean().default(false),
});
export type DiffResult = z.infer<typeof DiffResultSchema>;

export const MissionSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  goal: z.string(),
  acceptanceCriteria: z.array(z.string()),
  repoPath: z.string(),
  status: MissionStatusSchema,
  /** Hard token/cost ceiling, or null for "no budget cap". */
  budget: z.number().int().min(0).nullable(),
  spentTokens: z.number().int().min(0),
  /** ISO wall-clock deadline, or null. */
  deadline: z.string().nullable(),
  /**
   * Per-mission "team config": which provider/model each role uses for THIS
   * mission (e.g. Claude implements, Gemini critiques). Persisted on the mission
   * row; the worker merges it over the global env default to build this mission's
   * agents. Empty/undefined = inherit the global default everywhere.
   */
  roleModels: RoleModelsConfigSchema.optional(),
  /**
   * Free-text course-correction from a human (M3 Trin 6). Set on a RUNNING mission,
   * it flows into the next replan/decompose context — a steer beyond Stop that never
   * blocks the loop. STANDING, not one-shot: it keeps shaping every subsequent
   * planning round until a human changes or clears it (set to empty). Null = none.
   */
  guidance: z.string().nullable(),
  /**
   * Governor counters PERSISTED across restarts so the termination guarantee
   * survives a PM2 restart (a thrashing mission re-earning its full iteration /
   * no-progress budget every restart would loop forever otherwise). `iterations`
   * is the backstop iteration count; `noProgress` is the consecutive
   * no-newly-done-item count. The controller seeds these from the row on resume
   * and writes them back each loop iteration. Default 0 for a fresh mission.
   */
  iterations: z.number().int().min(0).default(0),
  noProgress: z.number().int().min(0).default(0),
  createdAt: z.string(),
});
export type Mission = z.infer<typeof MissionSchema>;

export const BacklogItemSchema = z.object({
  id: z.string(),
  missionId: z.string(),
  title: z.string(),
  detail: z.string(),
  status: BacklogItemStatusSchema,
  /** Higher value = worked sooner. */
  priority: z.number().int(),
  /** Ids of items that must be `done` before this one is actionable. */
  dependsOn: z.array(z.string()),
  risk: RiskSchema,
  /** The run that executed this item, once started — links to the transcript. */
  runId: z.string().nullable(),
  verification: VerificationSchema.nullable(),
  /** The structured diff of the code this item authored (M3 Trin 5); null until it runs. */
  diff: DiffResultSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type BacklogItem = z.infer<typeof BacklogItemSchema>;

/** Fields callers supply when opening a mission; the store fills id/status/timestamps. */
export interface CreateMissionInput {
  projectId: string;
  goal: string;
  repoPath: string;
  acceptanceCriteria?: string[];
  budget?: number | null;
  deadline?: string | null;
  /** Per-mission per-role model choices (the team config); inherits global default if omitted. */
  roleModels?: RoleModelsConfig;
  /** Optional initial course-correction text; usually set later on a running mission. */
  guidance?: string | null;
}

export type MissionPatch = Partial<
  Pick<
    Mission,
    | "status"
    | "spentTokens"
    | "deadline"
    | "budget"
    | "roleModels"
    | "guidance"
    | "iterations"
    | "noProgress"
  >
>;

/** Fields callers supply when adding a backlog item; the store fills the rest. */
export interface CreateBacklogItemInput {
  missionId: string;
  title: string;
  detail?: string;
  priority?: number;
  dependsOn?: string[];
  risk?: Risk;
}

export type BacklogItemPatch = Partial<
  Pick<
    BacklogItem,
    "title" | "detail" | "status" | "priority" | "dependsOn" | "risk" | "runId" | "verification" | "diff"
  >
>;

/**
 * The backlog capability the mission controller loop (`runMission`, §5.3) needs,
 * as a pure interface. Owns missions and their backlog items; `nextActionable`
 * encodes the prioritise-respecting-dependencies pick the loop drives.
 */
export interface BacklogStore {
  // ── missions ──
  createMission(input: CreateMissionInput): Promise<Mission>;
  getMission(id: string): Promise<Mission | null>;
  listMissions(): Promise<Mission[]>;
  updateMission(id: string, patch: MissionPatch): Promise<Mission | null>;
  /** Delete a mission and (via cascade) its backlog items. */
  deleteMission(id: string): Promise<void>;

  // ── backlog items ──
  createItem(input: CreateBacklogItemInput): Promise<BacklogItem>;
  getItem(id: string): Promise<BacklogItem | null>;
  listItems(missionId: string): Promise<BacklogItem[]>;
  updateItem(id: string, patch: BacklogItemPatch): Promise<BacklogItem | null>;
  /**
   * The highest-priority `todo` item whose `dependsOn` are all `done`, or null
   * when nothing is currently actionable (everything done, in-flight, parked,
   * or blocked on unmet dependencies). The loop interprets null as
   * done | blocked | stop.
   */
  nextActionable(missionId: string): Promise<BacklogItem | null>;
}
