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

/**
 * One step of an architect's plan. `title` alone is what a plan used to be — a
 * bare imperative sentence. The rest is the handoff: a worker on a CHEAPER model
 * should be able to execute this step without re-deriving what the architect
 * already worked out. When only `title` is set the step degrades to the old
 * behaviour, which is what makes a blind (no-repo) architect still valid.
 */
export const PlanStepSchema = z.object({
  title: z.string().describe("The step as one concrete, imperative sentence."),
  files: z
    .array(z.string())
    .default([])
    .describe("Exact paths this step creates or changes, as verified in the repo."),
  change: z
    .string()
    .optional()
    .describe("What specifically to do in those files — the approach, not a restatement of the title."),
  verify: z
    .string()
    .optional()
    .describe("The concrete check that proves this step works, e.g. a real allowlisted check name."),
  done: z.string().optional().describe("The observable condition that makes this step finished."),
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

/**
 * Accept both plan shapes. Checkpoints written before the plan became structured
 * hold `string[]`, and LangGraph rehydrates them verbatim on resume — coercing
 * here (rather than migrating stored state) means an in-flight run resumes into
 * the new code instead of crashing on `step.title` of a string.
 */
export function toPlanStep(step: PlanStep | string): PlanStep {
  return typeof step === "string" ? { title: step, files: [] } : step;
}

/** Render a step for a prompt: the title alone, or the full brief when there is one. */
export function formatPlanStep(step: PlanStep | string): string {
  const s = toPlanStep(step);
  const parts = [
    s.files.length ? `Files: ${s.files.join(", ")}` : "",
    s.change ? `Change: ${s.change}` : "",
    s.verify ? `Verify: ${s.verify}` : "",
    s.done ? `Done when: ${s.done}` : "",
  ].filter(Boolean);
  return parts.length ? `${s.title}\n${parts.map((p) => `  - ${p}`).join("\n")}` : s.title;
}

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
  // Reads tolerate `string[]` from pre-structured checkpoints (see `toPlanStep`);
  // the reducer normalises on write so everything downstream sees PlanStep.
  plan: Annotation<PlanStep[], ReadonlyArray<PlanStep | string>>({
    reducer: (_a, b) => b.map(toPlanStep),
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
