import type { Callbacks } from "@langchain/core/callbacks/manager";
import { Command } from "@langchain/langgraph";
import type { Verification } from "./mission.js";
import type { GraphStateType, RunStatus, Verdict } from "./state.js";
import type { Worktree, WorktreeManager } from "./worktree.js";
import { usageMetadata, type UsageContext } from "./usage.js";

/**
 * The "run one unit of work" capability the mission controller loop (§5.3) needs,
 * as a pure interface. `runMission` calls `runWorkItem(item)` per backlog item;
 * the WorkRunner drives the existing project/team graph and hands back the
 * deliverable. Kept abstract so the loop never knows which graph, model, or
 * checkpointer is behind it — exactly like `BacklogStore`/`Verifier`.
 */

export interface WorkItem {
  /** Doubles as the run/thread id — each item is checkpointed under its own id. */
  id: string;
  title: string;
  detail?: string;
  /** Mission goal + retrieved context, prepended to steer the run. */
  context?: string;
  /**
   * Why this item's previous attempt failed verification, if it did: `check`
   * names the checks that failed, `output` is a bounded tail of what they
   * printed. Shown to the implementer with the critic's issues, so a retry fixes
   * what the checks reported rather than trusting its own last summary.
   */
  failedVerification?: Verification;
}

export interface WorkResult {
  /** Equals the item id — the checkpointed thread that holds the full transcript. */
  runId: string;
  status: RunStatus;
  /** The produced deliverable (the graph's final draft). */
  draft: string;
  verdict: Verdict | null;
  /**
   * Tokens THIS run spent. The controller adds it to the mission's spend after
   * every attempt, so it never includes an earlier attempt of the same item.
   */
  tokensUsed: number;
  /**
   * One id per run of an item. Every model call in the run is tagged with it, so
   * a usage ledger can tell a retry's spend from the attempt before it. The
   * thread stays the item id (the dashboard reads it); only attribution is per run.
   */
  attemptId?: string;
  /**
   * Absolute path to the worktree the item ran in, when it ran write-capably in
   * isolation (M2 Trin 4). The controller verifies the authored code HERE rather
   * than in the main repo. Undefined for the read-only planning runner.
   */
  worktree?: string;
  /** The branch the item was authored on, for the integration/merge step (Trin 5). */
  branch?: string;
}

export interface WorkRunner {
  /** Run one item to a terminal state and return its deliverable. */
  run(item: WorkItem, signal?: AbortSignal): Promise<WorkResult>;
}

/**
 * Structural view of a compiled LangGraph graph — just the two methods the
 * runner uses. Lets the adapter accept any of the four compiled graphs without
 * coupling core to a specific factory's return type.
 */
export interface RunnableMissionGraph {
  invoke(input: unknown, config?: unknown): Promise<unknown>;
  getState(config: unknown): Promise<{
    values: unknown;
    tasks: ReadonlyArray<{ interrupts?: ReadonlyArray<unknown> }>;
  }>;
}

export interface GraphWorkRunnerOptions {
  /** Extra initial state merged into every run (e.g. `{ projectId }` for the project graph). */
  baseInput?: Partial<GraphStateType>;
  /** Build the task text from an item. Default: context + title + detail. */
  buildTask?: (item: WorkItem) => string;
  /**
   * How many times to auto-clear the human gate before giving up. In mission
   * mode the human never blocks — the Verifier (real checks), not the gate,
   * decides "done" — so the runner approves the gate to extract the draft and
   * lets verification + replan judge it. Default 3 (a backstop, not a loop).
   */
  maxGateResumes?: number;
  /**
   * Callback handlers attached to every graph run — e.g. the usage recorder.
   * Inheritable: they see every model call beneath the run, including each turn
   * inside the implementer's tool loop.
   */
  callbacks?: Callbacks;
  /** Attribution added to every run's metadata (e.g. `{ missionId }`). The runner adds the item and the attempt itself. */
  usageContext?: UsageContext;
}

function defaultBuildTask(item: WorkItem): string {
  const parts = [item.context?.trim(), item.title.trim(), item.detail?.trim()].filter(
    (p): p is string => !!p,
  );
  return parts.join("\n\n");
}

/**
 * The per-attempt counters every run starts from. A retried item runs again
 * under the same thread_id, and an input on an existing thread leaves every
 * channel it doesn't write as the last attempt left it — so without this a
 * retry would carry over `tokensUsed` (which the controller then bills again)
 * and `round` (spending the critic's revision budget before the retry's first
 * review). `draft` and `verdict` are deliberately carried over: the worktree is
 * reused as-is, so the last summary and the critic's last issues still describe
 * the code the retry starts from. What the checks said about that code is not
 * carried over: each attempt is handed it fresh (`WorkItem.failedVerification`).
 */
const FRESH_ATTEMPT = { round: 0, tokensUsed: 0 } satisfies Partial<GraphStateType>;

/**
 * Adapt any compiled graph into a WorkRunner. Pure: the runtime supplies the
 * already-compiled graph (with its model + checkpointer baked in); this only
 * drives it. Runs the item under `thread_id = item.id` as a fresh attempt
 * (`FRESH_ATTEMPT`), auto-advances the human gate, then reads the final
 * checkpoint for the deliverable.
 */
export function createGraphWorkRunner(
  graph: RunnableMissionGraph,
  options: GraphWorkRunnerOptions = {},
): WorkRunner {
  const buildTask = options.buildTask ?? defaultBuildTask;
  const maxGateResumes = options.maxGateResumes ?? 3;

  return {
    async run(item, signal): Promise<WorkResult> {
      const attemptId = globalThis.crypto.randomUUID();
      const config = {
        configurable: { thread_id: item.id },
        signal,
        callbacks: options.callbacks,
        metadata: usageMetadata({ ...options.usageContext, itemId: item.id, attemptId }),
      };
      const task = buildTask(item);
      // Written on every attempt, null included: left unwritten, the thread would
      // hand an older attempt's failure to a retry whose last attempt passed.
      const failedVerification = item.failedVerification ?? null;

      await graph.invoke({ ...FRESH_ATTEMPT, task, failedVerification, ...options.baseInput }, config);

      // Mission mode never blocks at the gate: approve it to surface the draft.
      for (let i = 0; i < maxGateResumes; i++) {
        const snap = await graph.getState(config);
        const interrupted = snap.tasks.some((t) => (t.interrupts ?? []).length > 0);
        if (!interrupted) break;
        await graph.invoke(new Command({ resume: { decision: "approve" } }), config);
      }

      const snap = await graph.getState(config);
      const state = snap.values as GraphStateType;
      return {
        runId: item.id,
        attemptId,
        status: state.status,
        draft: state.draft ?? "",
        verdict: state.verdict ?? null,
        tokensUsed: state.tokensUsed ?? 0,
      };
    },
  };
}

export interface WorktreeWorkRunnerOptions extends GraphWorkRunnerOptions {
  /** Provisions one isolated worktree per item (Trin 2). */
  worktrees: WorktreeManager;
  /**
   * Compile a graph rooted at the given worktree — typically
   * `createImplementerGraph` with `WritableRepoTools` pointed at `worktree.path`.
   * Called once per item so each runs against its own working tree.
   */
  buildGraph: (worktree: Worktree) => RunnableMissionGraph;
  /**
   * Deterministic branch name for an item. Caller-supplied so core never invents
   * names or reads the clock — e.g. `mission/<id>/item/<itemId>`.
   */
  branch: (item: WorkItem) => string;
  /** Ref the item branch is based on when first created. Default "HEAD". */
  baseRef?: string;
  /**
   * Optional setup run in the fresh worktree before the graph (e.g. install
   * dependencies so checks can run). The runtime supplies it — core stays pure.
   */
  prepare?: (worktree: Worktree) => Promise<void>;
}

/**
 * Write-capable WorkRunner (M2 build-order Trin 4): for each item it provisions
 * an isolated worktree, optionally prepares it (deps), runs the per-worktree
 * graph (the implementer authoring real code), and returns the deliverable plus
 * the worktree path — so the controller verifies the AUTHORED code in that
 * worktree, not the untouched main repo. Reuses `createGraphWorkRunner` for the
 * actual graph drive + gate handling. The worktree is left in place for the
 * integration/merge step (Trin 5) to consume and clean up.
 */
export function createWorktreeWorkRunner(
  options: WorktreeWorkRunnerOptions,
): WorkRunner {
  const { worktrees, buildGraph, branch, baseRef, prepare, ...graphOptions } = options;
  return {
    async run(item, signal): Promise<WorkResult> {
      const wt = await worktrees.create({ id: item.id, branch: branch(item), baseRef });
      if (prepare) await prepare(wt);
      const inner = createGraphWorkRunner(buildGraph(wt), graphOptions);
      const res = await inner.run(item, signal);
      return { ...res, worktree: wt.path, branch: wt.branch };
    },
  };
}
