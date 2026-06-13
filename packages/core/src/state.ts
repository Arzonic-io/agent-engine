import { Annotation } from "@langchain/langgraph";
import { z } from "zod";

export const AgentMessageSchema = z.object({
  agent: z.enum(["builder", "critic", "human", "system"]),
  role: z.enum(["assistant", "user", "system"]),
  content: z.string(),
});
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

export const VerdictSchema = z.object({
  pass: z.boolean(),
  score: z.number().min(0).max(100),
  issues: z.array(z.string()),
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
});

export type GraphStateType = typeof GraphState.State;
