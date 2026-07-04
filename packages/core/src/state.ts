import { Annotation } from "@langchain/langgraph";
import { z } from "zod";
import type { RubricCriterion } from "./rubric.js";

export const AgentMessageSchema = z.object({
  agent: z.enum([
    "builder",
    "critic",
    "human",
    "system",
    "analyst",
    "architect",
    "lead",
    "worker",
    "implementer",
  ]),
  role: z.enum(["assistant", "user", "system"]),
  content: z.string(),
});
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

export const StepResultSchema = z.object({ step: z.string(), output: z.string() });
export type StepResult = z.infer<typeof StepResultSchema>;

export const CriterionResultSchema = z.object({
  id: z.string(),
  label: z.string(),
  met: z.boolean(),
  required: z.boolean(),
});
export type CriterionResult = z.infer<typeof CriterionResultSchema>;

export const VerdictSchema = z.object({
  pass: z.boolean(),
  score: z.number().min(0).max(100),
  issues: z.array(z.string()),
  criteria: z.array(CriterionResultSchema).optional(),
});
export type Verdict = z.infer<typeof VerdictSchema>;

export const RunStatusSchema = z.enum([
  "running",
  "awaiting_human",
  "accepted",
  "failed",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

/** Zod schema for the full run state — single source of truth for the shape. */
export const RunStateSchema = z.object({
  task: z.string(),
  messages: z.array(AgentMessageSchema),
  draft: z.string(),
  round: z.number().int().min(0),
  verdict: VerdictSchema.nullable(),
  status: RunStatusSchema,
  tokensUsed: z.number().int().min(0),
});
export type RunState = z.infer<typeof RunStateSchema>;

/** LangGraph channel definitions, typed off the zod schema above. */
export const GraphState = Annotation.Root({
  task: Annotation<string>,
  messages: Annotation<AgentMessage[]>({
    reducer: (a, b) => a.concat(b),
    default: () => [],
  }),
  draft: Annotation<string>({
    reducer: (_a, b) => b,
    default: () => "",
  }),
  round: Annotation<number>({
    reducer: (_a, b) => b,
    default: () => 0,
  }),
  verdict: Annotation<Verdict | null>({
    reducer: (_a, b) => b,
    default: () => null,
  }),
  status: Annotation<RunStatus>({
    reducer: (_a, b) => b,
    default: () => "running",
  }),
  tokensUsed: Annotation<number>({
    reducer: (_a, b) => b,
    default: () => 0,
  }),
  // Free-text guidance a human injects at the gate to steer the next round.
  humanNotes: Annotation<string>({
    reducer: (_a, b) => b,
    default: () => "",
  }),
  // ── team mode (architect → workers → lead) ──
  plan: Annotation<string[]>({
    reducer: (_a, b) => b,
    default: () => [],
  }),
  currentStep: Annotation<number>({
    reducer: (_a, b) => b,
    default: () => 0,
  }),
  stepResults: Annotation<StepResult[]>({
    reducer: (a, b) => a.concat(b),
    default: () => [],
  }),
  // ── project mode (memory + adaptive routing) ──
  projectId: Annotation<string>({
    reducer: (_a, b) => b,
    default: () => "",
  }),
  // Retrieved project context (brief + top-k memory) injected into every agent.
  context: Annotation<string>({
    reducer: (_a, b) => b,
    default: () => "",
  }),
  // Topology the router chose for this task.
  topology: Annotation<"single" | "team">({
    reducer: (_a, b) => b,
    default: () => "single",
  }),
  /**
   * When set, the router uses this topology verbatim instead of asking the model
   * — the "Override" affordance on the run page (re-run this task as single/team).
   * Null (default) = the router picks. Additive: existing runs never set it.
   */
  forcedTopology: Annotation<"single" | "team" | null>({
    reducer: (_a, b) => b,
    default: () => null,
  }),
  /**
   * Task-relevant criteria the proposer added on top of the base rubric for THIS
   * run (adaptive Definition of Done). Always folded in as optional — they inform
   * score + feedback but never gate a pass; the human controls what's required via
   * the per-project rubric. Empty (default) = no adaptive criteria.
   */
  extraCriteria: Annotation<RubricCriterion[]>({
    reducer: (_a, b) => b,
    default: () => [],
  }),
});

export type GraphStateType = typeof GraphState.State;
