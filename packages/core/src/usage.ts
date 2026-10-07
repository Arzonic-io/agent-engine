/**
 * Usage attribution: which mission, item, attempt and agent role a model call
 * belongs to. Pure data — core never stores usage. It only tags LangChain runs
 * with metadata. The runtime attaches a callback handler (shared's usage
 * recorder) at the OUTERMOST invoke, and that handler reads these keys off every
 * model call beneath it.
 *
 * Why metadata and not node-local bookkeeping: LangChain's callback managers
 * carry inheritable metadata from the outermost run down to every nested model
 * call — each turn inside a ReAct loop included, and calls in a loop that later
 * throws. Tagging once at each boundary therefore attributes every call beneath
 * it without threading a meter through every node. That only holds when the
 * handler is inheritable (passed at the top-level invoke), never when it sits on
 * a model as a constructor callback.
 */
import type { RunnableConfig } from "@langchain/core/runnables";

/** Every place a model is called from — one role per call-site family. */
export const USAGE_ROLES = [
  "router",
  "architect",
  "proposeCriteria",
  "builder",
  "critic",
  "worker",
  "lead",
  "analyst",
  "survey",
  "decompose",
  "implementer",
  "missionCritic",
  "tester",
  "replan",
  "rubricAssessor",
] as const;
export type UsageRole = (typeof USAGE_ROLES)[number];

/** The metadata keys the usage recorder reads. Prefixed so they never collide with LangChain's own. */
export const USAGE_METADATA_KEYS = {
  role: "ae_role",
  missionId: "ae_mission_id",
  itemId: "ae_item_id",
  attemptId: "ae_attempt_id",
  taskId: "ae_task_id",
} as const;

/** What a call belongs to. Every field is optional — a run sets what it knows. */
export interface UsageContext {
  missionId?: string;
  itemId?: string;
  /** One id per run of an item, so a retry's spend is told apart from the attempt before it. */
  attemptId?: string;
  /** An interactive run: the tasks.id, or the ad-hoc run id of a run without a project. */
  taskId?: string;
}

/** The context as LangChain metadata, leaving out what isn't known. */
export function usageMetadata(context: UsageContext): Record<string, string> {
  const out: Record<string, string> = {};
  if (context.missionId) out[USAGE_METADATA_KEYS.missionId] = context.missionId;
  if (context.itemId) out[USAGE_METADATA_KEYS.itemId] = context.itemId;
  if (context.attemptId) out[USAGE_METADATA_KEYS.attemptId] = context.attemptId;
  if (context.taskId) out[USAGE_METADATA_KEYS.taskId] = context.taskId;
  return out;
}

/**
 * A call config tagged with `role` (and optionally a context), keeping every key
 * the caller already set — `signal`, `recursionLimit`, `callbacks` and its own
 * metadata. Pass the result as the invoke config at a model call site.
 *
 * Any defined `callbacks` value — even `[]` — REPLACES the inherited callback
 * manager; pass callbacks only at a top-level invoke, never inside a graph node.
 */
export function withUsage(
  role: UsageRole,
  config: RunnableConfig = {},
  context: UsageContext = {},
): RunnableConfig {
  return {
    ...config,
    metadata: {
      ...config.metadata,
      ...usageMetadata(context),
      [USAGE_METADATA_KEYS.role]: role,
    },
  };
}
