import { BadRequestException } from "@nestjs/common";
import type { ModelProvider, RoleModelsConfig } from "@arzonic/agent-core";
import type { ApiEnv } from "./env.js";

/**
 * Every provider a team-config references must have its API key set server-side,
 * else the worker couldn't build that agent. Throw a 400 for fast feedback —
 * the single guard every door into a persisted team config funnels through:
 * mission create/update, per-project team defaults, and the global default.
 */
export function assertProvidersConfigured(
  env: ApiEnv,
  roleModels: RoleModelsConfig | undefined,
): void {
  const keyFor: Record<ModelProvider, string | undefined> = {
    mistral: env.MISTRAL_API_KEY,
    anthropic: env.ANTHROPIC_API_KEY,
    google: env.GOOGLE_API_KEY,
  };
  for (const [role, spec] of Object.entries(roleModels ?? {})) {
    if (spec && !keyFor[spec.provider]) {
      throw new BadRequestException(
        `Role '${role}' uses provider '${spec.provider}', but its API key is not configured on the server.`,
      );
    }
  }
}
