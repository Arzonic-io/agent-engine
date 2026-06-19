import { RoleModelsConfigSchema } from "@arzonic/agent-core";
import { z } from "zod";

/** Body of PUT /settings/role-models — the global default team config. */
export const UpdateRoleModelsSchema = z.object({
  roleModels: RoleModelsConfigSchema,
});
export type UpdateRoleModelsDto = z.infer<typeof UpdateRoleModelsSchema>;
