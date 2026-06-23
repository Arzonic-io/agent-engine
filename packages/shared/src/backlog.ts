import type { RoleModelsConfig } from "@arzonic/agent-core";
import pg from "pg";

const { Pool } = pg;

/**
 * Mission + backlog persistence, backed by the same local Postgres the
 * checkpointer and project memory use (§5.2 of the design brief). Tables live
 * beside project memory, not inside it — a mission links to a project but is its
 * own entity. Pure runtime service: the controller loop calls it through the
 * injected `BacklogStore` interface in core, keeping `core` framework-free.
 *
 * Mirrors the type shapes in `@arzonic/agent-core` (`Mission`, `BacklogItem`);
 * kept structurally compatible so the API can hand this straight to `runMission`.
 */

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

export interface Verification {
  passed: boolean;
  check: string;
  output: string;
}

export interface Mission {
  id: string;
  projectId: string;
  goal: string;
  acceptanceCriteria: string[];
  repoPath: string;
  status: MissionStatus;
  budget: number | null;
  spentTokens: number;
  deadline: string | null;
  /** Per-mission per-role model choices (the team config); empty = global default. */
  roleModels: RoleModelsConfig;
  createdAt: string;
}

export interface BacklogItem {
  id: string;
  missionId: string;
  title: string;
  detail: string;
  status: BacklogItemStatus;
  priority: number;
  dependsOn: string[];
  risk: Risk;
  runId: string | null;
  verification: Verification | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMissionInput {
  projectId: string;
  goal: string;
  repoPath: string;
  acceptanceCriteria?: string[];
  budget?: number | null;
  deadline?: string | null;
  roleModels?: RoleModelsConfig;
}

export type MissionPatch = Partial<
  Pick<Mission, "status" | "spentTokens" | "deadline" | "budget" | "roleModels">
>;

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
    "title" | "detail" | "status" | "priority" | "dependsOn" | "risk" | "runId" | "verification"
  >
>;

export interface BacklogServiceOptions {
  connectionString: string;
}

export class BacklogService {
  private readonly pool: pg.Pool;

  constructor(opts: BacklogServiceOptions) {
    this.pool = new Pool({ connectionString: opts.connectionString });
  }

  /** Idempotent schema setup — both tables + the actionable-lookup index. Run once at boot. */
  async setup(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS missions (
        id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id          uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        goal                text NOT NULL,
        acceptance_criteria jsonb NOT NULL DEFAULT '[]',
        repo_path           text NOT NULL,
        status              text NOT NULL DEFAULT 'running',
        budget              bigint,
        spent_tokens        bigint NOT NULL DEFAULT 0,
        deadline            timestamptz,
        role_models         jsonb NOT NULL DEFAULT '{}',
        created_at          timestamptz NOT NULL DEFAULT now()
      )`);
    // Add the per-mission team-config column to pre-existing missions tables.
    await this.pool.query(
      `ALTER TABLE missions ADD COLUMN IF NOT EXISTS role_models jsonb NOT NULL DEFAULT '{}'`,
    );
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS backlog_items (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        mission_id   uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        title        text NOT NULL,
        detail       text NOT NULL DEFAULT '',
        status       text NOT NULL DEFAULT 'todo',
        priority     integer NOT NULL DEFAULT 0,
        depends_on   jsonb NOT NULL DEFAULT '[]',
        risk         text NOT NULL DEFAULT 'low',
        run_id       text,
        verification jsonb,
        created_at   timestamptz NOT NULL DEFAULT now(),
        updated_at   timestamptz NOT NULL DEFAULT now()
      )`);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS backlog_items_mission_status_idx
      ON backlog_items (mission_id, status)`);
  }

  // ── missions ──
  async createMission(input: CreateMissionInput): Promise<Mission> {
    const { rows } = await this.pool.query(
      `INSERT INTO missions (project_id, goal, repo_path, acceptance_criteria, budget, deadline, role_models)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        input.projectId,
        input.goal,
        input.repoPath,
        JSON.stringify(input.acceptanceCriteria ?? []),
        input.budget ?? null,
        input.deadline ?? null,
        JSON.stringify(input.roleModels ?? {}),
      ],
    );
    return this.mapMission(rows[0]);
  }

  async getMission(id: string): Promise<Mission | null> {
    const { rows } = await this.pool.query(`SELECT * FROM missions WHERE id=$1`, [id]);
    return rows[0] ? this.mapMission(rows[0]) : null;
  }

  async listMissions(): Promise<Mission[]> {
    const { rows } = await this.pool.query(`SELECT * FROM missions ORDER BY created_at DESC`);
    return rows.map((r) => this.mapMission(r));
  }

  async updateMission(id: string, patch: MissionPatch): Promise<Mission | null> {
    const cols: Record<keyof MissionPatch, string> = {
      status: "status",
      spentTokens: "spent_tokens",
      deadline: "deadline",
      budget: "budget",
      roleModels: "role_models",
    };
    // role_models is a jsonb column — stringify it like the item-side json fields.
    const json = new Set<keyof MissionPatch>(["roleModels"]);
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    for (const [k, v] of Object.entries(patch)) {
      const key = k as keyof MissionPatch;
      sets.push(`${cols[key]} = $${i++}`);
      vals.push(json.has(key) ? JSON.stringify(v) : v);
    }
    if (sets.length === 0) return this.getMission(id);
    vals.push(id);
    const { rows } = await this.pool.query(
      `UPDATE missions SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
      vals,
    );
    return rows[0] ? this.mapMission(rows[0]) : null;
  }

  /** Delete a mission; backlog_items cascade via the FK. */
  async deleteMission(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM missions WHERE id=$1`, [id]);
  }

  // ── backlog items ──
  async createItem(input: CreateBacklogItemInput): Promise<BacklogItem> {
    const { rows } = await this.pool.query(
      `INSERT INTO backlog_items (mission_id, title, detail, priority, depends_on, risk)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [
        input.missionId,
        input.title,
        input.detail ?? "",
        input.priority ?? 0,
        JSON.stringify(input.dependsOn ?? []),
        input.risk ?? "low",
      ],
    );
    return this.mapItem(rows[0]);
  }

  async getItem(id: string): Promise<BacklogItem | null> {
    const { rows } = await this.pool.query(`SELECT * FROM backlog_items WHERE id=$1`, [id]);
    return rows[0] ? this.mapItem(rows[0]) : null;
  }

  async listItems(missionId: string): Promise<BacklogItem[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM backlog_items WHERE mission_id=$1
       ORDER BY priority DESC, created_at ASC`,
      [missionId],
    );
    return rows.map((r) => this.mapItem(r));
  }

  async updateItem(id: string, patch: BacklogItemPatch): Promise<BacklogItem | null> {
    const cols: Record<keyof BacklogItemPatch, string> = {
      title: "title",
      detail: "detail",
      status: "status",
      priority: "priority",
      dependsOn: "depends_on",
      risk: "risk",
      runId: "run_id",
      verification: "verification",
    };
    const json = new Set<keyof BacklogItemPatch>(["dependsOn", "verification"]);
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    for (const [k, v] of Object.entries(patch)) {
      const key = k as keyof BacklogItemPatch;
      sets.push(`${cols[key]} = $${i++}`);
      vals.push(json.has(key) ? JSON.stringify(v) : v);
    }
    sets.push(`updated_at = now()`);
    vals.push(id);
    const { rows } = await this.pool.query(
      `UPDATE backlog_items SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
      vals,
    );
    return rows[0] ? this.mapItem(rows[0]) : null;
  }

  /**
   * Highest-priority `todo` item whose every dependency is `done`, else null.
   * Dependency satisfaction is checked in SQL: an item is blocked if any id in
   * its `depends_on` array names an item that is not yet done.
   */
  async nextActionable(missionId: string): Promise<BacklogItem | null> {
    const { rows } = await this.pool.query(
      `SELECT b.* FROM backlog_items b
       WHERE b.mission_id = $1 AND b.status = 'todo'
         AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements_text(b.depends_on) dep
           JOIN backlog_items d ON d.id = dep::uuid
           WHERE d.status <> 'done'
         )
       ORDER BY b.priority DESC, b.created_at ASC
       LIMIT 1`,
      [missionId],
    );
    return rows[0] ? this.mapItem(rows[0]) : null;
  }

  async end(): Promise<void> {
    await this.pool.end();
  }

  private mapMission(r: pg.QueryResultRow): Mission {
    return {
      id: r.id,
      projectId: r.project_id,
      goal: r.goal,
      acceptanceCriteria: r.acceptance_criteria ?? [],
      repoPath: r.repo_path,
      status: r.status,
      budget: r.budget === null ? null : Number(r.budget),
      spentTokens: Number(r.spent_tokens ?? 0),
      deadline: r.deadline ? new Date(r.deadline).toISOString() : null,
      roleModels: r.role_models ?? {},
      createdAt: new Date(r.created_at).toISOString(),
    };
  }

  private mapItem(r: pg.QueryResultRow): BacklogItem {
    return {
      id: r.id,
      missionId: r.mission_id,
      title: r.title,
      detail: r.detail,
      status: r.status,
      priority: Number(r.priority ?? 0),
      dependsOn: r.depends_on ?? [],
      risk: r.risk,
      runId: r.run_id,
      verification: r.verification ?? null,
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
    };
  }
}
