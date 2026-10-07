import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  type OnModuleDestroy,
} from "@nestjs/common";
import {
  ignoreElements,
  interval,
  map,
  merge,
  ReplaySubject,
  takeUntil,
  type Observable,
} from "rxjs";
import {
  createAgentGraph,
  createProjectGraph,
  createRepoAnalysisGraph,
  createTeamGraph,
  defaultRubric,
  resolveProjectRubric,
  RubricSchema,
  usageMetadata,
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
  listGitHubIssues,
  type GitHubRepo,
  type GitHubIssue,
  type MemoryService,
  type RepoInfo,
  type UsageSummary,
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
import { CHECKPOINTER, ENV, MEMORY, MODEL, ROLE_MODELS, USAGE } from "../tokens.js";
import type { UsageHandle } from "../usage.provider.js";
import type { DecisionDto, StartRunDto } from "./dto/runs.dto.js";

const REJECTION_MARKER = "Rejected final draft.";

/**
 * Cap on each run's ReplaySubject buffer — unbounded before this, so a long
 * run's token/node/verdict history could grow without limit. A reconnecting
 * client that misses more than this many historical events falls back to the
 * "rebuild transcript from persisted messages" path (frontend) plus a REST
 * refetch, both of which recover full fidelity from the checkpointer/DB.
 */
const EVENTS_REPLAY_BUFFER = 500;

/** Runs that will never emit again — eligible for eviction once old enough. */
const TERMINAL_RUN_STATUSES = new Set<ApiRunStatus>(["accepted", "rejected", "failed"]);

/** How often the in-memory registry is swept for long-terminal runs. */
const RUN_SWEEP_INTERVAL_MS = 10 * 60_000;

/** macOS and Windows resolve paths case-insensitively; Linux does not. */
const CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32";

/** Graph nodes that surface their work through returned messages (vs. builder's draft). */
const MESSAGE_NODES = new Set(["analyst", "architect", "worker", "lead"]);
/** Project-graph nodes whose system messages we surface (router decision, memory ops). */
const SYSTEM_NODES = new Set(["retrieveContext", "router", "persistMemory"]);

/** Rubric registry — extend here when product-specific rubrics land. */
const RUBRICS: Record<string, Rubric> = {
  default: defaultRubric,
};

/**
 * A wire event plus the monotonic per-run sequence number the SSE layer sends
 * as the frame's `id:`. Reconnects replay the buffered history, so without a
 * stable id per event a client can only key on arrival order — and appends the
 * whole replayed prefix a second time (the "every system message shows twice"
 * bug). The id travels *with* the buffered event so it survives replay.
 */
type StampedRunEvent = RunEvent & { seq: number };

interface RunMeta {
  runId: string;
  task: string;
  createdAt: string;
  status: ApiRunStatus;
  /** Last sequence number handed out by `emit()` for this run. */
  seq: number;
  events: ReplaySubject<StampedRunEvent>;
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
  /** Periodic eviction of long-terminal runs — see sweepTerminalRuns(). */
  private readonly sweepTimer: ReturnType<typeof setInterval>;

  constructor(
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(MODEL) private readonly model: BaseChatModel,
    @Inject(ROLE_MODELS) private readonly roleModels: RoleModels,
    @Inject(CHECKPOINTER) private readonly checkpointer: CheckpointerHandle,
    @Inject(MEMORY) private readonly memory: MemoryService | null,
    @Inject(USAGE) private readonly usageHandle: UsageHandle | null,
  ) {
    this.sweepTimer = setInterval(() => this.sweepTerminalRuns(), RUN_SWEEP_INTERVAL_MS);
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.sweepTimer);
    for (const meta of this.runs.values()) meta.abort.abort();
    // Write the last buffered calls before the process goes.
    await this.usageHandle?.recorder.close();
    await this.checkpointer.close();
  }

  /**
   * Evict long-terminal runs from the in-memory registry. Each entry holds a
   * ReplaySubject that can buffer a fair amount of token text, so without this
   * the map grows without bound until PM2's `max_memory_restart` force-kills
   * the whole process — destroying every OTHER in-flight run's live stream at
   * once. Never touches "running"/"awaiting_human" regardless of age (a human
   * may not act on a gate for a long time). Only drops the in-memory entry —
   * the checkpointer/DB task row is untouched, since `getRun()`'s checkpointer
   * fallback still needs to serve historical data after eviction.
   */
  private sweepTerminalRuns(): void {
    const cutoff = Date.now() - this.env.RUN_RETENTION_MS;
    for (const [runId, meta] of this.runs) {
      if (!TERMINAL_RUN_STATUSES.has(meta.status)) continue;
      if (new Date(meta.createdAt).getTime() < cutoff) this.runs.delete(runId);
    }
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

  /**
   * A project's own rubric (settings.rubric), floor-enforced — or undefined to
   * fall back to the default. A malformed stored rubric is ignored (never crashes
   * a run); the required floor is always applied on the way out.
   */
  private projectRubric(project: { settings?: Record<string, unknown> }): Rubric | undefined {
    const raw = project.settings?.rubric;
    if (!raw) return undefined;
    const parsed = RubricSchema.safeParse(raw);
    return parsed.success ? resolveProjectRubric(parsed.data) : undefined;
  }

  /**
   * A project's preferred topology (settings.defaultTopology) — forces the router
   * onto single/team for every text task in the project. Undefined = "auto" (the
   * router decides per task), the default.
   */
  private projectDefaultTopology(project: {
    settings?: Record<string, unknown>;
  }): "single" | "team" | undefined {
    const t = project.settings?.defaultTopology;
    return t === "single" || t === "team" ? t : undefined;
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
      llmCallTimeoutMs: this.env.LLM_CALL_TIMEOUT_MS,
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

  /**
   * Expand a leading "~". `resolve` treats it as an ordinary path segment, so an
   * unexpanded "~/x" silently becomes "<cwd>/~/x" — which can even pass the root
   * check when the cwd is inside a root, then fail later as a missing repo.
   */
  private expandHome(repoPath: string): string {
    if (repoPath === "~") return homedir();
    if (repoPath.startsWith(`~${sep}`)) return join(homedir(), repoPath.slice(2));
    return repoPath;
  }

  /** Validate a client-supplied repo path against REPO_ALLOWED_ROOTS (if configured). */
  private resolveRepoPath(repoPath: string): string {
    const abs = resolve(this.expandHome(repoPath));
    const roots = this.env.REPO_ALLOWED_ROOTS;
    if (roots.length > 0) {
      // Compare the way the filesystem does. On macOS/Windows ".../Github/x" and
      // ".../GitHub/x" are the same directory, so a case-sensitive string compare
      // rejects a path that is genuinely inside the root.
      const fold = (p: string) => (CASE_INSENSITIVE_FS ? p.toLowerCase() : p);
      const target = fold(abs);
      const ok = roots.some((root) => {
        const r = fold(resolve(root));
        const rel = relative(r, target);
        return target === r || (!rel.startsWith("..") && !rel.startsWith(`..${sep}`));
      });
      if (!ok) {
        // Name the rejected path: without it the caller cannot tell whether they
        // sent a typo, a relative path, or a genuinely out-of-bounds repo.
        throw new BadRequestException(
          `repoPath "${abs}" is outside the allowed roots: ${roots.join(", ")}`,
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
      llmCallTimeoutMs: this.env.LLM_CALL_TIMEOUT_MS,
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
  private makeProjectGraph(
    options?: StartRunDto["options"],
    rubricId?: string,
    rubric?: Rubric,
  ): AgentGraph {
    return createProjectGraph({
      model: this.model,
      models: this.roleModels,
      memory: this.requireMemory(),
      checkpointer: this.checkpointer.saver,
      // An explicit per-project rubric wins over the named-registry lookup.
      rubric: rubric ?? this.rubricFor(rubricId),
      guardrails: this.guardrails(options),
      adaptiveRubric: this.env.ADAPTIVE_RUBRIC,
      llmCallTimeoutMs: this.env.LLM_CALL_TIMEOUT_MS,
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
      llmCallTimeoutMs: this.env.LLM_CALL_TIMEOUT_MS,
    });
  }

  private config(runId: string, signal?: AbortSignal) {
    return {
      configurable: { thread_id: runId },
      signal,
      // Every model call in the run lands in the usage ledger, tagged with the run.
      ...(this.usageHandle
        ? { callbacks: [this.usageHandle.recorder.handler], metadata: usageMetadata({ taskId: runId }) }
        : {}),
    };
  }

  /** What one run's model calls cost, per role — from the usage ledger. */
  async usage(runId: string): Promise<UsageSummary> {
    if (!this.usageHandle) {
      throw new BadRequestException("Usage needs a database — set SUPABASE_DB_URL.");
    }
    return this.usageHandle.ledger.taskSummary(runId);
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
   * A repo's open GitHub issues — for the "start a mission from an issue" picker.
   * Same token as the repo picker / Publisher. Throws a clear 503 when no token is
   * configured so the UI can hide the feature.
   */
  async listGitHubIssues(owner: string, repo: string): Promise<GitHubIssue[]> {
    if (!this.env.GITHUB_TOKEN) {
      throw new ServiceUnavailableException(
        "GITHUB_TOKEN is not configured — set it to pick GitHub issues.",
      );
    }
    try {
      return await listGitHubIssues({ token: this.env.GITHUB_TOKEN, owner, repo });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // A 403/404 on the issues endpoint means the fine-grained PAT can't read
      // issues on this repo — Contents/Pull-requests access (what the repo picker
      // + Publisher need) does NOT include Issues. Surface a clean, actionable
      // message instead of a bare 500 so the picker can tell the human what to fix.
      if (/HTTP 40[134]|not accessible/i.test(msg)) {
        throw new ForbiddenException(
          `GITHUB_TOKEN mangler adgang til issues på ${owner}/${repo}. ` +
            `Tilføj "Issues: Read" til det fine-grained token på GitHub.`,
        );
      }
      throw new ServiceUnavailableException(msg);
    }
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
    forcedTopology?: "single" | "team",
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
      : this.makeProjectGraph(undefined, undefined, this.projectRubric(project));

    // A forced topology only bites the project graph's router — a repo-analysis
    // task has no router, so it's silently ignored there. Precedence: an explicit
    // caller override (a re-run) wins over the project's default topology.
    const topology = forcedTopology ?? this.projectDefaultTopology(project);
    const seed = { task, projectId: project.id, status: "running" as const };
    const input = (
      !effectiveRepo && topology ? { ...seed, forcedTopology: topology } : seed
    ) as GraphInput;

    return this.launch(runId, task, graph, input, project.id);
  }

  /**
   * Re-run an existing run's task with a forced topology — the "Override" control
   * on the run page. Starts a FRESH run (new thread) so the original stays intact;
   * the new run skips the router and uses `topology` verbatim. Router-override only
   * exists on the project graph, so this requires memory.
   */
  async rerunWithTopology(
    runId: string,
    topology: "single" | "team",
  ): Promise<StartRunResponse> {
    const graph = this.graphFor(runId);
    const snapshot = await graph.getState(this.config(runId));
    const state = snapshot.values as GraphStateType | undefined;
    if (!state || !state.task) {
      throw new NotFoundException(`No run found for id ${runId}`);
    }
    return this.startProjectTask(state.projectId || "scratch", state.task, undefined, topology);
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
      seq: 0,
      events: new ReplaySubject<StampedRunEvent>(EVENTS_REPLAY_BUFFER),
      abort: new AbortController(),
      graph,
      projectId,
    };
    this.runs.set(runId, meta);

    // Fire-and-forget: launch() returns to the caller immediately with
    // status "running" — the SSE stream (or the frontend's polling fallback)
    // is how progress and the eventual outcome surface.
    void this.driveWithGuardrails(graph, meta, input);

    return { runId, threadId: runId, status: "running" };
  }

  /** Publish one wire event, stamped with this run's next sequence number. */
  private emit(meta: RunMeta, event: RunEvent): void {
    meta.events.next({ ...event, seq: ++meta.seq });
  }

  /**
   * Drive one graph segment with a whole-segment timeout, turning a thrown
   * error (or a timeout-triggered abort) into a wire `error` event AND a
   * persisted, corrected `tasks` row — without this, a timed-out/failed run's
   * DB status stays stuck on `"running"` forever even though `meta.status`
   * in memory is right. Shared by `launch()` (fire-and-forget) and `decide()`
   * (awaited, so the resume/"revise" path — previously the one place with NO
   * timeout or catch at all — gets the exact same safety net rather than
   * hanging the HTTP request indefinitely on a stuck LLM call).
   */
  private async driveWithGuardrails(
    graph: AgentGraph,
    meta: RunMeta,
    input: GraphInput,
  ): Promise<void> {
    const timeout = setTimeout(() => meta.abort.abort(), this.env.RUN_TIMEOUT_MS);
    try {
      await this.consume(graph, meta, input);
    } catch (err) {
      meta.status = "failed";
      this.emit(meta, {
        type: "error",
        message: meta.abort.signal.aborted
          ? `Run timed out after ${this.env.RUN_TIMEOUT_MS} ms`
          : err instanceof Error
            ? err.message
            : String(err),
      });
      meta.events.complete();
      try {
        const snapshot = await graph.getState(this.config(meta.runId));
        await this.syncTask(meta, snapshot.values as GraphStateType);
      } catch {
        /* best-effort — matches syncTask's own swallow-on-failure style */
      }
    } finally {
      clearTimeout(timeout);
    }
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
          this.emit(meta, { type: "token", node, content: text });
        }
        continue;
      }

      const update = data as Record<string, Partial<GraphStateType>>;
      for (const [node, patch] of Object.entries(update)) {
        if (node === "builder" && patch) {
          // Finalize the streamed message with the authoritative full draft.
          this.emit(meta, {
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
            this.emit(meta, {
              type: "node",
              node: node as "analyst" | "architect" | "worker" | "lead",
              round: patch.round ?? 0,
              content: m.content,
              tokens: patch.tokensUsed,
            });
          }
        } else if (node === "critic" && patch?.verdict) {
          this.emit(meta, {
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
            this.emit(meta, {
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
      this.emit(meta, { type: "awaiting_human", runId: meta.runId });
      void this.syncTask(meta, state);
      return; // subject stays open — decision() continues it
    }

    meta.status = this.mapStatus(state);
    this.emit(meta, {
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
    // Surface the router's decision only when a router actually ran (project-graph
    // text tasks). The message format is `Router → <topology>: <reason>`.
    const routerMsg = [...state.messages]
      .reverse()
      .find((m) => m.agent === "system" && m.content.startsWith("Router → "));
    const routerReason = routerMsg
      ? routerMsg.content.replace(/^Router → (?:single|team): /, "")
      : null;
    // Real wall-clock bounds for the run, so the UI can show how long it
    // actually took rather than how long the tab has been open. The persisted
    // task row outlives the in-memory registry (which the sweeper evicts), so
    // it wins for `startedAt`; both stay null for pre-timestamp runs.
    const row = await this.taskRow(runId);
    // The run knows its project, but the UI never did — so "back" from a run
    // landed on whatever project happened to be active, which for a run opened
    // from the cross-project list is usually the wrong one.
    const projectId = row?.projectId ?? state.projectId ?? this.runs.get(runId)?.projectId ?? null;
    const projectName = projectId ? await this.projectName(projectId) : null;
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
      topology: routerMsg ? state.topology : null,
      routerReason,
      projectId,
      projectName,
      startedAt: row?.createdAt ?? this.runs.get(runId)?.createdAt ?? null,
      finishedAt: row?.finishedAt ?? null,
    };
  }

  /** A project's display name for the run breadcrumb; null when unavailable. */
  private async projectName(projectId: string): Promise<string | null> {
    if (!this.memory) return null;
    try {
      return (await this.memory.getProject(projectId))?.name ?? null;
    } catch {
      return null; /* best-effort — the breadcrumb falls back to "Projekt" */
    }
  }

  /** The persisted task row for a run (null when memory is off or it's ad-hoc). */
  private async taskRow(runId: string) {
    if (!this.memory) return null;
    try {
      return await this.memory.getTask(runId);
    } catch {
      return null; /* best-effort — the UI just falls back to "—" */
    }
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
        seq: 0,
        events: new ReplaySubject<StampedRunEvent>(EVENTS_REPLAY_BUFFER),
        abort: new AbortController(),
        graph,
        projectId: state.projectId || undefined,
      };
      this.runs.set(runId, meta);
    }

    // Resume with the decision + notes. On 'revise' the graph loops back to the
    // builder with the notes as guidance, streams the new round(s), and pauses
    // at the gate again (or terminates) — all handled inside consume().
    // Routed through the same timeout+catch+persist safety net launch() uses
    // (driveWithGuardrails) — previously this call had NEITHER, so a hung
    // LLM call on a revise loop would hang this HTTP request forever with no
    // way for the run to ever be marked failed.
    await this.driveWithGuardrails(
      graph,
      meta,
      new Command({ resume: { decision: dto.decision, notes: dto.notes } }) as GraphInput,
    );

    return { runId, status: meta.status };
  }

  events(runId: string): Observable<StampedRunEvent> {
    const meta = this.runs.get(runId);
    if (!meta) {
      throw new NotFoundException(
        `No live event stream for run ${runId} (it may predate a restart — poll GET /runs/${runId} instead)`,
      );
    }
    const events$ = meta.events.asObservable();
    // Long team-topology node calls (architect/worker/lead/critic) stream
    // zero bytes over the wire otherwise, which an idle-timeout proxy/tunnel
    // can silently kill with nothing in the app ever noticing. Merge in a
    // periodic pure-liveness frame — `takeUntil(events$.ignoreElements())` is
    // NOT optional: a bare `merge(events$, interval$)` would never complete,
    // since `interval()` never completes on its own and `merge()` only
    // completes once every source does — that would leave the HTTP response
    // (and the CLI SDK's stream readers, which wait for the body to end) open
    // forever after a run has actually finished.
    // seq 0 marks "not part of the run's event history" — heartbeats are
    // per-subscription liveness, never replayed, so they carry no SSE id and
    // can't disturb a reconnecting client's dedupe cursor.
    const heartbeat$ = interval(this.env.RUN_HEARTBEAT_MS).pipe(
      map((): StampedRunEvent => ({ type: "heartbeat", seq: 0 })),
      takeUntil(events$.pipe(ignoreElements())),
    );
    return merge(events$, heartbeat$);
  }
}
