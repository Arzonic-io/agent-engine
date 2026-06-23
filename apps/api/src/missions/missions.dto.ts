import { RoleModelsConfigSchema } from "@arzonic/agent-core";
import { z } from "zod";

const NewBacklogItemSchema = z.object({
  title: z.string().min(1).max(500),
  detail: z.string().max(20_000).optional(),
  priority: z.number().int().optional(),
  dependsOn: z.array(z.string()).optional(),
  risk: z.enum(["low", "high"]).optional(),
});

export const CreateMissionSchema = z.object({
  projectId: z.string().min(1),
  goal: z.string().min(1).max(20_000),
  repoPath: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).max(50).optional(),
  budget: z.number().int().min(1).nullable().optional(),
  deadline: z.iso.datetime().nullable().optional(),
  items: z.array(NewBacklogItemSchema).max(200).optional(),
  /** Per-mission team config: role → { provider, model? }. Inherits global default if omitted. */
  roleModels: RoleModelsConfigSchema.optional(),
  /** Optional initial operator guidance steering the first decompose (M3 Trin 6). */
  guidance: z.string().max(10_000).optional(),
});
export type CreateMissionDto = z.infer<typeof CreateMissionSchema>;

export const MissionItemDecisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
});
export type MissionItemDecisionDto = z.infer<typeof MissionItemDecisionSchema>;

/** Body of PATCH /missions/:id/role-models — re-point a running mission's team. */
export const UpdateMissionRoleModelsSchema = z.object({
  roleModels: RoleModelsConfigSchema,
});
export type UpdateMissionRoleModelsDto = z.infer<typeof UpdateMissionRoleModelsSchema>;

/**
 * Body of PATCH /missions/:id/guidance — course-correct a running mission (M3 Trin 6).
 * An empty string / null clears the guidance.
 */
export const UpdateMissionGuidanceSchema = z.object({
  guidance: z.string().max(10_000).nullable(),
});
export type UpdateMissionGuidanceDto = z.infer<typeof UpdateMissionGuidanceSchema>;
