import { Command } from "@langchain/langgraph";
import type { GraphStateType, RunStatus, Verdict } from "./state.js";

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
}

export interface WorkResult {
  /** Equals the item id — the checkpointed thread that holds the full transcript. */
  runId: string;
  status: RunStatus;
  /** The produced deliverable (the graph's final draft). */
  draft: string;
  verdict: Verdict | null;
  tokensUsed: number;
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
}

function defaultBuildTask(item: WorkItem): string {
  const parts = [item.context?.trim(), item.title.trim(), item.detail?.trim()].filter(
    (p): p is string => !!p,
  );
  return parts.join("\n\n");
}

/**
 * Adapt any compiled graph into a WorkRunner. Pure: the runtime supplies the
 * already-compiled graph (with its model + checkpointer baked in); this only
 * drives it. Runs the item under `thread_id = item.id`, auto-advances the human
 * gate, then reads the final checkpoint for the deliverable.
 */
export function createGraphWorkRunner(
  graph: RunnableMissionGraph,
  options: GraphWorkRunnerOptions = {},
): WorkRunner {
  const buildTask = options.buildTask ?? defaultBuildTask;
  const maxGateResumes = options.maxGateResumes ?? 3;

  return {
    async run(item, signal): Promise<WorkResult> {
      const config = { configurable: { thread_id: item.id }, signal };
      const task = buildTask(item);

      await graph.invoke({ task, ...options.baseInput }, config);

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
        status: state.status,
        draft: state.draft ?? "",
        verdict: state.verdict ?? null,
        tokensUsed: state.tokensUsed ?? 0,
      };
    },
  };
}
