import { randomUUID } from "node:crypto";
import { relative, resolve, sep } from "node:path";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  type OnModuleDestroy,
} from "@nestjs/common";
import { ReplaySubject, type Observable } from "rxjs";
import {
  createAgentGraph,
  createProjectGraph,
  createRepoAnalysisGraph,
  createTeamGraph,
  defaultRubric,
  type AgentGraph,
  type GraphStateType,
  type RoleModels,
  type Rubric,
} from "@arzonic/agent-core";
import {
  createRepoTools,
  discoverRepos,
  ensureWorkspace,
  listGitHubRepos,
  type GitHubRepo,
  type MemoryService,
  type RepoInfo,
} from "@arzonic/agent-shared";
import type {
  ApiRunStatus,
  DecisionResponse,
  RunDetail,
  RunEvent,
  RunSummary,
  StartRunResponse,
} from "@arzonic/agent-client";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { Command } from "@langchain/langgraph";
import type { CheckpointerHandle } from "../checkpointer.js";
import type { ApiEnv } from "../env.js";
import { CHECKPOINTER, ENV, MEMORY, MODEL, ROLE_MODELS } from "../tokens.js";
import type { DecisionDto, StartRunDto } from "./dto/runs.dto.js";

const REJECTION_MARKER = "Rejected final draft.";

/** Graph nodes that surface their work through returned messages (vs. builder's draft). */
const MESSAGE_NODES = new Set(["analyst", "architect", "worker", "lead"]);
/** Project-graph nodes whose system messages we surface (router decision, memory ops). */
const SYSTEM_NODES = new Set(["retrieveContext", "router", "persistMemory"]);

/** Rubric registry — extend here when product-specific rubrics land. */
const RUBRICS: Record<string, Rubric> = {
  default: defaultRubric,
};

interface RunMeta {
  runId: string;
  task: string;
  createdAt: string;
  status: ApiRunStatus;
  events: ReplaySubject<RunEvent>;
  abort: AbortController;
  /** The exact compiled graph this run uses — reused for resume so topology matches. */
  graph: AgentGraph;
  projectId?: string;
}

type GraphInput = Parameters<AgentGraph["stream"]>[0];

@Injectable()
export class RunsService implements OnModuleDestroy {
  /** In-process registry for the list view + live event subjects. State itself lives in the checkpointer. */
  private readonly runs = new Map<string, RunMeta>();

  constructor(
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(MODEL) private readonly model: BaseChatModel,
    @Inject(ROLE_MODELS) private readonly roleModels: RoleModels,
    @Inject(CHECKPOINTER) private readonly checkpointer: CheckpointerHandle,
    @Inject(MEMORY) private readonly memory: MemoryService | null,
  ) {}

  async onModuleDestroy(): Promise<void> {
    for (const meta of this.runs.values()) meta.abort.abort();
    await this.checkpointer.close();
  }

  private rubricFor(rubricId?: string): Rubric {
    const rubric = RUBRICS[rubricId ?? "default"];
    if (!rubric) {
      throw new NotFoundException(
        `Unknown rubricId '${rubricId}'. Available: ${Object.keys(RUBRICS).join(", ")}`,
      );
    }
    return rubric;
  }

  private guardrails(options?: StartRunDto["options"]) {
    return {
      maxRounds: options?.maxRounds ?? this.env.MAX_ROUNDS,
      tokenBudget: this.env.RUN_TOKEN_BUDGET,
    };
  }

  /** Builder↔critic graph — used for starting text runs and for reading/resuming any run's state. */
  private makeGraph(options?: StartRunDto["options"], rubricId?: string): AgentGraph {
    return createAgentGraph({
      model: this.model,
      models: this.roleModels,
      checkpointer: this.checkpointer.saver,
      rubric: this.rubricFor(rubricId),
      guardrails: this.guardrails(options),
    });
  }

  /**
   * Validate a client-supplied repo path against REPO_ALLOWED_ROOTS and return
   * its resolved absolute form. Public so ProjectsController can validate a
   * repo before persisting it on a project. Throws BadRequest if out of bounds.
   */
  validateRepoPath(repoPath: string): string {
    return this.resolveRepoPath(repoPath);
  }

  /** Validate a client-supplied repo path against REPO_ALLOWED_ROOTS (if configured). */
  private resolveRepoPath(repoPath: string): string {
    const abs = resolve(repoPath);
    const roots = this.env.REPO_ALLOWED_ROOTS;
    if (roots.length > 0) {
      const ok = roots.some((root) => {
        const r = resolve(root);
        const rel = relative(r, abs);
        return abs === r || (!rel.startsWith("..") && !rel.startsWith(`..${sep}`));
      });
      if (!ok) {
        throw new BadRequestException(
          `repoPath must be within an allowed root: ${roots.join(", ")}`,
        );
      }
    }
    return abs;
  }

  /** Team graph: architect → workers → lead, challenged by the critic. */
  private makeTeamGraph(options?: StartRunDto["options"], rubricId?: string) {
    return createTeamGraph({
      model: this.model,
      models: this.roleModels,
      checkpointer: this.checkpointer.saver,
      rubric: this.rubricFor(rubricId),
      guardrails: this.guardrails(options),
    });
  }

  private requireMemory(): MemoryService {
    if (!this.memory) {
      throw new BadRequestException(
        "Project tasks need memory — set SUPABASE_DB_URL + MISTRAL_API_KEY.",
      );
    }
    return this.memory;
  }

  /** Project graph: retrieveContext → router → (single | team) → gate → persistMemory. */
  private makeProjectGraph(options?: StartRunDto["options"], rubricId?: string): AgentGraph {
    return createProjectGraph({
      model: this.model,
      models: this.roleModels,
      memory: this.requireMemory(),
      checkpointer: this.checkpointer.saver,
      rubric: this.rubricFor(rubricId),
      guardrails: this.guardrails(options),
    }) as unknown as AgentGraph;
  }

  /** Grounded repo-analysis graph: a tool-using analyst (read-only) refined by the critic. */
  private makeRepoGraph(repoPath: string, options?: StartRunDto["options"], rubricId?: string) {
    return createRepoAnalysisGraph({
      model: this.model,
      models: this.roleModels,
      checkpointer: this.checkpointer.saver,
      rubric: this.rubricFor(rubricId),
      guardrails: this.guardrails(options),
      tools: createRepoTools(this.resolveRepoPath(repoPath), {
        allowedChecks: this.env.REPO_ALLOWED_CHECKS,
      }),
    });
  }

  private config(runId: string, signal?: AbortSignal) {
    return { configurable: { thread_id: runId }, signal };
  }

  /**
   * The graph to read/resume a run with. Reuses the run's own compiled graph
   * when in memory; after a restart, falls back to the project graph (which
   * routes by the persisted topology) or the builder graph if memory is off.
   */
  private graphFor(runId: string): AgentGraph {
    const meta = this.runs.get(runId);
    if (meta) return meta.graph;
    return this.memory ? this.makeProjectGraph() : this.makeGraph();
  }

  /** Repos the worker can be pointed at — discovered under REPO_ALLOWED_ROOTS. */
  listRepos(): Promise<RepoInfo[]> {
    return discoverRepos(this.env.REPO_ALLOWED_ROOTS);
  }

  /**
   * The GitHub repos the configured token can push to — for the "pick a repo,
   * not a path" project picker. Throws a clear 503 when no token is configured so
   * the UI can fall back to the local-path picker.
   */
  listGitHubRepos(): Promise<GitHubRepo[]> {
    if (!this.env.GITHUB_TOKEN) {
      throw new ServiceUnavailableException(
        "GITHUB_TOKEN is not configured — set it to pick GitHub repos.",
      );
    }
    return listGitHubRepos({ token: this.env.GITHUB_TOKEN });
  }

  /**
   * Ensure a managed working clone of `owner/repo` exists under
   * MISSION_WORKSPACE_ROOT and return its absolute path — what a project stores as
   * its repoPath. Clones on first bind, fetches+fast-forwards on later binds. The
   * path is server-generated, so it bypasses the client-path REPO_ALLOWED_ROOTS gate.
   */
  async ensureGitHubWorkspace(
    owner: string,
    repo: string,
  ): Promise<{ path: string; defaultBranch: string }> {
    if (!this.env.GITHUB_TOKEN) {
      throw new ServiceUnavailableException(
        "GITHUB_TOKEN is not configured — cannot bind a GitHub repo.",
      );
    }
    const ws = await ensureWorkspace({
      root: resolve(this.env.MISSION_WORKSPACE_ROOT),
      owner,
      repo,
      token: this.env.GITHUB_TOKEN,
    });
    return { path: ws.path, defaultBranch: ws.defaultBranch };
  }

  start(dto: StartRunDto): StartRunResponse {
    const graph = dto.repoPath
      ? (this.makeRepoGraph(dto.repoPath, dto.options, dto.rubricId) as unknown as AgentGraph)
      : dto.mode === "team"
        ? (this.makeTeamGraph(dto.options, dto.rubricId) as unknown as AgentGraph)
        : this.makeGraph(dto.options, dto.rubricId);
    const runId = randomUUID();
    return this.launch(runId, dto.task, graph, { task: dto.task, status: "running" });
  }

  /**
   * Start a task scoped to a project. Uses the repo-analysis graph when a repo
   * is given, otherwise the project graph (router → single/team + memory).
   * `projectId` may be "scratch" to fall back to the implicit project.
   */
  async startProjectTask(
    projectId: string,
    task: string,
    repoPath?: string,
  ): Promise<StartRunResponse> {
    const memory = this.requireMemory();
    let project =
      projectId === "scratch"
        ? await this.scratchProject()
        : await memory.getProject(projectId);
    if (!project) throw new NotFoundException(`No project ${projectId}`);

    // Per-task repoPath overrides the project's bound repo; otherwise the task
    // inherits whatever repo the project is configured with (settings.repoPath).
    const projectRepo =
      typeof project.settings?.repoPath === "string" ? project.settings.repoPath : undefined;
    const effectiveRepo = repoPath ?? projectRepo;

    const row = await memory.createTask(project.id, task);
    const runId = row.id; // task id doubles as the run/thread id
    const graph = effectiveRepo
      ? (this.makeRepoGraph(effectiveRepo) as unknown as AgentGraph)
      : this.makeProjectGraph();

    return this.launch(runId, task, graph, { task, projectId: project.id, status: "running" }, project.id);
  }

  private async scratchProject() {
    const memory = this.requireMemory();
    const existing = (await memory.listProjects()).find((p) => p.name === "Scratch");
    return existing ?? memory.createProject("Scratch", "Ad-hoc tasks without a dedicated project.");
  }

  /** Register a run, kick off its graph with the timeout/error harness, and return the handle. */
  private launch(
    runId: string,
    task: string,
    graph: AgentGraph,
    input: GraphInput,
    projectId?: string,
  ): StartRunResponse {
    const meta: RunMeta = {
      runId,
      task,
      createdAt: new Date().toISOString(),
      status: "running",
      events: new ReplaySubject<RunEvent>(),
      abort: new AbortController(),
      graph,
      projectId,
    };
    this.runs.set(runId, meta);

    const timeout = setTimeout(() => meta.abort.abort(), this.env.RUN_TIMEOUT_MS);
    void this.consume(graph, meta, input)
      .catch((err: unknown) => {
        meta.status = "failed";
        meta.events.next({
          type: "error",
          message: meta.abort.signal.aborted
            ? `Run timed out after ${this.env.RUN_TIMEOUT_MS} ms`
            : err instanceof Error
              ? err.message
              : String(err),
        });
        meta.events.complete();
      })
      .finally(() => clearTimeout(timeout));

    return { runId, threadId: runId, status: "running" };
  }

  /** Drive one graph segment and translate updates into typed wire events. */
  private async consume(graph: AgentGraph, meta: RunMeta, input: GraphInput): Promise<void> {
    // Two modes at once: "messages" gives token-by-token LLM output (live
    // typing), "updates" gives the finalized per-node state delta.
    const stream = await graph.stream(input, {
      ...this.config(meta.runId, meta.abort.signal),
      streamMode: ["messages", "updates"],
    });

    for await (const [mode, data] of stream as AsyncIterable<[string, unknown]>) {
      if (mode === "messages") {
        const [msg, metadata] = data as [
          { content?: unknown },
          { langgraph_node?: string } | undefined,
        ];
        const node = metadata?.langgraph_node;
        const text = typeof msg?.content === "string" ? msg.content : "";
        // Stream the builder's natural-language tokens live. The critic emits
        // structured JSON, and the analyst makes many intermediate tool-deciding
        // calls — neither is useful to stream token-by-token.
        if (text && node === "builder") {
          meta.events.next({ type: "token", node, content: text });
        }
        continue;
      }

      const update = data as Record<string, Partial<GraphStateType>>;
      for (const [node, patch] of Object.entries(update)) {
        if (node === "builder" && patch) {
          // Finalize the streamed message with the authoritative full draft.
          meta.events.next({
            type: "node",
            node: "builder",
            round: patch.round ?? 0,
            content: patch.draft ?? "",
            tokens: patch.tokensUsed,
          });
        } else if (MESSAGE_NODES.has(node) && patch) {
          // analyst / architect / worker / lead surface their work via the
          // messages they returned (tool traces, plan, step outputs, synthesis).
          for (const m of patch.messages ?? []) {
            meta.events.next({
              type: "node",
              node: node as "analyst" | "architect" | "worker" | "lead",
              round: patch.round ?? 0,
              content: m.content,
              tokens: patch.tokensUsed,
            });
          }
        } else if (node === "critic" && patch?.verdict) {
          meta.events.next({
            type: "verdict",
            round: await this.currentRound(graph, meta.runId),
            pass: patch.verdict.pass,
            score: patch.verdict.score,
            issues: patch.verdict.issues,
            criteria: patch.verdict.criteria,
            tokens: patch.tokensUsed,
          });
        } else if (SYSTEM_NODES.has(node) && patch) {
          // retrieveContext / router / persistMemory — surface their system note
          // (e.g. "Router → team: …", "Retrieved brief + N memories").
          for (const m of patch.messages ?? []) {
            meta.events.next({
              type: "node",
              node: "system",
              round: patch.round ?? 0,
              content: m.content,
              tokens: patch.tokensUsed,
            });
          }
        }
      }
    }

    // Segment ended: either paused at the human gate or terminal.
    const snapshot = await graph.getState(this.config(meta.runId));
    const state = snapshot.values as GraphStateType;
    const interrupted = snapshot.tasks.some((t) => (t.interrupts ?? []).length > 0);

    if (interrupted) {
      meta.status = "awaiting_human";
      meta.events.next({ type: "awaiting_human", runId: meta.runId });
      void this.syncTask(meta, state);
      return; // subject stays open — decision() continues it
    }

    meta.status = this.mapStatus(state);
    meta.events.next({
      type: "done",
      status: meta.status,
      result: { draft: state.draft, verdict: state.verdict },
    });
    void this.syncTask(meta, state);
    meta.events.complete();
  }

  /** Mirror a project run's progress into the tasks table (best-effort). */
  private async syncTask(meta: RunMeta, state: GraphStateType): Promise<void> {
    if (!meta.projectId || !this.memory) return;
    try {
      await this.memory.updateTask(meta.runId, {
        status: meta.status,
        topology: state.topology,
        draft: state.draft,
        verdict: state.verdict as unknown,
      });
    } catch {
      /* best-effort */
    }
  }

  private async currentRound(graph: AgentGraph, runId: string): Promise<number> {
    const snapshot = await graph.getState(this.config(runId));
    return (snapshot.values as GraphStateType | undefined)?.round ?? 0;
  }

  /** Core knows 'failed'; the API distinguishes a human rejection from a real failure. */
  private mapStatus(state: GraphStateType): ApiRunStatus {
    if (state.status === "failed") {
      const rejected = state.messages.some(
        (m) => m.agent === "human" && m.content === REJECTION_MARKER,
      );
      return rejected ? "rejected" : "failed";
    }
    return state.status;
  }

  async getRun(runId: string): Promise<RunDetail> {
    const graph = this.graphFor(runId);
    const snapshot = await graph.getState(this.config(runId));
    const state = snapshot.values as GraphStateType | undefined;
    if (!state || !state.task) {
      throw new NotFoundException(`No run found for id ${runId}`);
    }
    const interrupted = snapshot.tasks.some((t) => (t.interrupts ?? []).length > 0);
    return {
      runId,
      threadId: runId,
      task: state.task,
      status: interrupted ? "awaiting_human" : this.mapStatus(state),
      round: state.round,
      tokensUsed: state.tokensUsed,
      draft: state.draft,
      verdict: state.verdict,
      messages: state.messages,
    };
  }

  list(): RunSummary[] {
    return [...this.runs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(({ runId, task, status, createdAt }) => ({ runId, task, status, createdAt }));
  }

  /** Delete a run: stop any live work, drop it from the registry, and erase its checkpointer thread. */
  async deleteRun(runId: string): Promise<void> {
    const meta = this.runs.get(runId);
    if (meta) {
      meta.abort.abort();
      meta.events.complete();
      this.runs.delete(runId);
    }
    const saver = this.checkpointer.saver as {
      deleteThread?: (threadId: string) => Promise<void>;
    };
    if (typeof saver.deleteThread === "function") {
      await saver.deleteThread(runId);
    }
    // The run id doubles as the project-task id; drop the persisted row too so
    // the project's task list (which the sidebar reads) stays in sync.
    if (this.memory) {
      try {
        await this.memory.deleteTask(runId);
      } catch {
        /* best-effort — the run is already gone from the registry */
      }
    }
  }

  async decide(runId: string, dto: DecisionDto): Promise<DecisionResponse> {
    const graph = this.graphFor(runId);
    const snapshot = await graph.getState(this.config(runId));
    const state = snapshot.values as GraphStateType | undefined;
    if (!state || !state.task) {
      throw new NotFoundException(`No run found for id ${runId}`);
    }
    const interrupted = snapshot.tasks.some((t) => (t.interrupts ?? []).length > 0);
    if (!interrupted) {
      throw new ConflictException(
        `Run ${runId} is not awaiting a human decision (status: ${this.mapStatus(state)})`,
      );
    }

    // Recreate meta after a restart so stream watchers still get the tail events.
    let meta = this.runs.get(runId);
    if (!meta) {
      meta = {
        runId,
        task: state.task,
        createdAt: new Date().toISOString(),
        status: "awaiting_human",
        events: new ReplaySubject<RunEvent>(),
        abort: new AbortController(),
        graph,
        projectId: state.projectId || undefined,
      };
      this.runs.set(runId, meta);
    }

    // Resume with the decision + notes. On 'revise' the graph loops back to the
    // builder with the notes as guidance, streams the new round(s), and pauses
    // at the gate again (or terminates) — all handled inside consume().
    await this.consume(
      graph,
      meta,
      new Command({ resume: { decision: dto.decision, notes: dto.notes } }) as GraphInput,
    );

    return { runId, status: meta.status };
  }

  events(runId: string): Observable<RunEvent> {
    const meta = this.runs.get(runId);
    if (!meta) {
      throw new NotFoundException(
        `No live event stream for run ${runId} (it may predate a restart — poll GET /runs/${runId} instead)`,
      );
    }
    return meta.events.asObservable();
  }
}
