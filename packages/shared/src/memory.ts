import { MistralAIEmbeddings } from "@langchain/mistralai";
import pg from "pg";

const { Pool } = pg;

/** Task statuses a run never leaves — the point where `finished_at` is stamped. */
const TERMINAL_TASK_STATUSES = new Set(["accepted", "rejected", "failed"]);

export interface Project {
  id: string;
  name: string;
  brief: string;
  settings: Record<string, unknown>;
  createdAt: string;
}

export interface Task {
  id: string;
  projectId: string;
  task: string;
  topology: "single" | "team" | null;
  status: string;
  draft: string | null;
  verdict: unknown;
  createdAt: string;
  /** When the run reached a terminal status; null while it is still open. */
  finishedAt: string | null;
}

/** Lightweight rollups the composer shows before the user types. */
export interface ProjectStats {
  /** Remembered items — non-brief `project_memory` rows (artifacts/decisions/notes). */
  memoryCount: number;
  /** Total tasks ever run in the project. */
  taskCount: number;
  /** ISO timestamp of the most recent task, or null if none yet. */
  lastTaskAt: string | null;
}

export interface ProjectWithStats extends Project {
  stats: ProjectStats;
}

/** A task tagged with its project name — for the global "recent tasks" feed. */
export interface RecentTask {
  id: string;
  projectId: string;
  projectName: string;
  task: string;
  topology: "single" | "team" | null;
  status: string;
  createdAt: string;
}

export type MemoryKind = "brief" | "artifact" | "decision" | "note";

export interface MemoryHit {
  kind: string;
  content: string;
  score: number;
}

export interface RetrievedContext {
  brief: string;
  hits: MemoryHit[];
}

export interface MemoryServiceOptions {
  connectionString: string;
  mistralApiKey: string;
  /** Embedding dimension — mistral-embed is 1024. */
  dim?: number;
}

/**
 * The engine's project store + RAG memory, backed by local Postgres + pgvector.
 * Owns projects, tasks, and the embedded project_memory. Pure runtime service —
 * the graph calls it through injected nodes, keeping `core` framework-free.
 */
export class MemoryService {
  private readonly pool: pg.Pool;
  private readonly embeddings: MistralAIEmbeddings;
  private readonly dim: number;

  constructor(opts: MemoryServiceOptions) {
    this.pool = new Pool({ connectionString: opts.connectionString });
    this.embeddings = new MistralAIEmbeddings({
      apiKey: opts.mistralApiKey,
      model: "mistral-embed",
    });
    this.dim = opts.dim ?? 1024;
  }

  /** Idempotent schema setup — extension, tables, HNSW index. Run once at boot. */
  async setup(): Promise<void> {
    await this.pool.query("CREATE EXTENSION IF NOT EXISTS vector");
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name        text NOT NULL,
        brief       text NOT NULL DEFAULT '',
        settings    jsonb NOT NULL DEFAULT '{}',
        created_at  timestamptz NOT NULL DEFAULT now()
      )`);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS project_memory (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind        text NOT NULL,
        content     text NOT NULL,
        embedding   vector(${this.dim}),
        metadata    jsonb NOT NULL DEFAULT '{}',
        created_at  timestamptz NOT NULL DEFAULT now()
      )`);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS project_memory_embedding_idx
      ON project_memory USING hnsw (embedding vector_cosine_ops)`);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task        text NOT NULL,
        topology    text,
        status      text NOT NULL DEFAULT 'running',
        draft       text,
        verdict     jsonb,
        created_at  timestamptz NOT NULL DEFAULT now()
      )`);
    // Added after the table shipped — CREATE TABLE IF NOT EXISTS never retrofits
    // a column, so an existing DB needs this to record when a run actually ended
    // (the run view's "varighed" reads created_at → finished_at, not wall clock).
    await this.pool.query(
      `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS finished_at timestamptz`,
    );
    // Self-heal: guarantee a task is deleted with its project even on a `tasks`
    // table created before ON DELETE CASCADE was in the schema — `CREATE TABLE IF
    // NOT EXISTS` never retrofits a constraint, so an older DB (e.g. the VPS) could
    // keep a plain/no-action FK and orphan tasks on project delete. Runs ONLY when
    // the cascade is missing (no-op on healthy DBs), and clears any pre-existing
    // orphans first so ADD CONSTRAINT can't fail on them.
    await this.ensureProjectCascade("tasks");
  }

  /**
   * Ensure `<table>.project_id` REFERENCES projects(id) ON DELETE CASCADE. Idempotent
   * and self-healing: skips entirely when the cascade already exists, otherwise drops
   * whatever FK is on the column (any name), purges orphaned rows, and re-adds it with
   * the cascade. Shared shape with the backlog store's missions table.
   */
  private async ensureProjectCascade(table: string): Promise<void> {
    await this.pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.referential_constraints rc
          JOIN information_schema.table_constraints tc
            ON tc.constraint_name = rc.constraint_name
           AND tc.constraint_schema = rc.constraint_schema
          WHERE tc.table_name = '${table}'
            AND tc.constraint_type = 'FOREIGN KEY'
            AND rc.delete_rule = 'CASCADE'
        ) THEN
          DELETE FROM ${table} WHERE project_id NOT IN (SELECT id FROM projects);
          EXECUTE COALESCE((
            SELECT string_agg(format('ALTER TABLE ${table} DROP CONSTRAINT %I;', tc.constraint_name), ' ')
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON kcu.constraint_name = tc.constraint_name
            WHERE tc.table_name = '${table}'
              AND tc.constraint_type = 'FOREIGN KEY'
              AND kcu.column_name = 'project_id'
          ), 'SELECT 1');
          ALTER TABLE ${table}
            ADD CONSTRAINT ${table}_project_id_fkey
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
        END IF;
      END $$;`);
  }

  // ── embeddings ──
  embed(text: string): Promise<number[]> {
    return this.embeddings.embedQuery(text);
  }

  private toVector(v: number[]): string {
    return `[${v.join(",")}]`;
  }

  // ── projects ──
  async createProject(name: string, brief: string, settings: Record<string, unknown> = {}): Promise<Project> {
    const { rows } = await this.pool.query(
      `INSERT INTO projects (name, brief, settings) VALUES ($1,$2,$3) RETURNING *`,
      [name, brief, settings],
    );
    const p = this.mapProject(rows[0]);
    if (brief.trim()) await this.store(p.id, "brief", brief);
    return p;
  }

  async listProjects(): Promise<Project[]> {
    const { rows } = await this.pool.query(`SELECT * FROM projects ORDER BY created_at DESC`);
    return rows.map((r) => this.mapProject(r));
  }

  /**
   * Projects enriched with the rollups the composer needs, ordered
   * most-recently-used first (latest task, then newest project) so the UI can
   * default to `rows[0]`. The brief row is excluded from `memoryCount` so a
   * freshly-created project correctly reads as "no memory yet".
   */
  async listProjectsWithStats(): Promise<ProjectWithStats[]> {
    const { rows } = await this.pool.query(`
      SELECT
        p.*,
        (SELECT count(*) FROM project_memory m
           WHERE m.project_id = p.id AND m.kind <> 'brief') AS memory_count,
        (SELECT count(*) FROM tasks t WHERE t.project_id = p.id) AS task_count,
        (SELECT max(t.created_at) FROM tasks t WHERE t.project_id = p.id) AS last_task_at
      FROM projects p
      ORDER BY last_task_at DESC NULLS LAST, p.created_at DESC
    `);
    return rows.map((r) => ({
      ...this.mapProject(r),
      stats: {
        memoryCount: Number(r.memory_count ?? 0),
        taskCount: Number(r.task_count ?? 0),
        lastTaskAt: r.last_task_at ? new Date(r.last_task_at).toISOString() : null,
      },
    }));
  }

  async getProject(id: string): Promise<Project | null> {
    const { rows } = await this.pool.query(`SELECT * FROM projects WHERE id=$1`, [id]);
    return rows[0] ? this.mapProject(rows[0]) : null;
  }

  /** Update a project's editable columns (name / brief). Only provided fields change. */
  async updateProject(
    id: string,
    patch: { name?: string; brief?: string },
  ): Promise<Project | null> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    if (patch.name !== undefined) {
      sets.push(`name = $${i++}`);
      vals.push(patch.name);
    }
    if (patch.brief !== undefined) {
      sets.push(`brief = $${i++}`);
      vals.push(patch.brief);
    }
    if (sets.length === 0) return this.getProject(id);
    vals.push(id);
    const { rows } = await this.pool.query(
      `UPDATE projects SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
      vals,
    );
    return rows[0] ? this.mapProject(rows[0]) : null;
  }

  /** Shallow-merge keys into a project's `settings` jsonb (e.g. `{ repoPath }`). */
  async updateProjectSettings(
    id: string,
    patch: Record<string, unknown>,
  ): Promise<Project | null> {
    const { rows } = await this.pool.query(
      `UPDATE projects SET settings = settings || $2::jsonb WHERE id=$1 RETURNING *`,
      [id, JSON.stringify(patch)],
    );
    return rows[0] ? this.mapProject(rows[0]) : null;
  }

  async deleteProject(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM projects WHERE id=$1`, [id]);
  }

  // ── tasks ──
  async createTask(projectId: string, task: string): Promise<Task> {
    const { rows } = await this.pool.query(
      `INSERT INTO tasks (project_id, task) VALUES ($1,$2) RETURNING *`,
      [projectId, task],
    );
    return this.mapTask(rows[0]);
  }

  async updateTask(
    id: string,
    patch: Partial<Pick<Task, "topology" | "status" | "draft" | "verdict">>,
  ): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    for (const [k, v] of Object.entries(patch)) {
      const col = k === "verdict" ? "verdict" : k;
      sets.push(`${col} = $${i++}`);
      vals.push(k === "verdict" ? JSON.stringify(v) : v);
    }
    // Stamp the end of the run the first time it lands on a terminal status —
    // COALESCE keeps the original moment if a later write repeats the status.
    if (patch.status && TERMINAL_TASK_STATUSES.has(patch.status)) {
      sets.push(`finished_at = COALESCE(finished_at, now())`);
    }
    if (sets.length === 0) return;
    vals.push(id);
    await this.pool.query(`UPDATE tasks SET ${sets.join(", ")} WHERE id = $${i}`, vals);
  }

  async deleteTask(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM tasks WHERE id=$1`, [id]);
  }

  /**
   * Recent tasks across ALL projects (newest first), each tagged with its
   * project name — the sidebar's global activity feed. Slim by design: no
   * draft/verdict, since the list only needs to link and label.
   */
  async listRecentTasks(limit = 100): Promise<RecentTask[]> {
    const { rows } = await this.pool.query(
      `SELECT t.id, t.project_id, p.name AS project_name, t.task, t.topology,
              t.status, t.created_at
       FROM tasks t
       JOIN projects p ON p.id = t.project_id
       WHERE p.name <> 'Scratch'
       ORDER BY t.created_at DESC
       LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      projectName: r.project_name,
      task: r.task,
      topology: r.topology,
      status: r.status,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }

  /** A single task row by id (= its runId), or null. Source of a run's real timestamps. */
  async getTask(id: string): Promise<Task | null> {
    const { rows } = await this.pool.query(`SELECT * FROM tasks WHERE id=$1`, [id]);
    return rows[0] ? this.mapTask(rows[0]) : null;
  }

  async listTasks(projectId: string): Promise<Task[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM tasks WHERE project_id=$1 ORDER BY created_at DESC`,
      [projectId],
    );
    return rows.map((r) => this.mapTask(r));
  }

  // ── memory (RAG) ──
  async store(
    projectId: string,
    kind: MemoryKind,
    content: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    if (!content.trim()) return;
    const v = await this.embed(content);
    await this.pool.query(
      `INSERT INTO project_memory (project_id, kind, content, embedding, metadata)
       VALUES ($1,$2,$3,$4::vector,$5)`,
      [projectId, kind, content, this.toVector(v), metadata],
    );
  }

  /** Top-k cosine matches for the query, plus the project brief (always included). */
  async retrieve(projectId: string, query: string, k = 6): Promise<RetrievedContext> {
    const qv = this.toVector(await this.embed(query));
    const briefRes = await this.pool.query(`SELECT brief FROM projects WHERE id=$1`, [projectId]);
    const brief: string = briefRes.rows[0]?.brief ?? "";
    const { rows } = await this.pool.query(
      `SELECT kind, content, 1 - (embedding <=> $2::vector) AS score
       FROM project_memory
       WHERE project_id = $1 AND kind <> 'brief'
       ORDER BY embedding <=> $2::vector
       LIMIT $3`,
      [projectId, qv, k],
    );
    return {
      brief,
      hits: rows.map((r) => ({ kind: r.kind, content: r.content, score: Number(r.score) })),
    };
  }

  async end(): Promise<void> {
    await this.pool.end();
  }

  private mapProject(r: pg.QueryResultRow): Project {
    return {
      id: r.id,
      name: r.name,
      brief: r.brief,
      settings: r.settings ?? {},
      createdAt: new Date(r.created_at).toISOString(),
    };
  }

  private mapTask(r: pg.QueryResultRow): Task {
    return {
      id: r.id,
      projectId: r.project_id,
      task: r.task,
      topology: r.topology,
      status: r.status,
      draft: r.draft,
      verdict: r.verdict,
      createdAt: new Date(r.created_at).toISOString(),
      finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
    };
  }
}
