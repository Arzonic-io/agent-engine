import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { z } from "zod";

/**
 * The roles that own an LLM call and can each be assigned their OWN model — the
 * configurable "team members". The runtime maps these to concrete models (e.g.
 * Gemini Flash for the critic, Claude for the implementer, Mistral for the
 * architect) and injects them; core stays pure — it only ever receives model
 * *instances*, never provider/key/transport config.
 *
 * Graph roles (architect/worker/lead/critic/builder/analyst/router) drive the
 * task & team graphs; mission roles (implementer/replan/decompose/tester) drive
 * the autonomous-mission loop. A role without an explicit assignment falls back
 * to a graph's default `model`, so this is purely additive — nothing breaks when
 * `models` is omitted.
 */
export const MODEL_ROLES = [
  "architect",
  "worker",
  "lead",
  "critic",
  "builder",
  "implementer",
  "analyst",
  "router",
  "replan",
  "decompose",
  "tester",
] as const;

export type ModelRole = (typeof MODEL_ROLES)[number];

/** Per-role model overrides; any unassigned role falls back to the graph's default `model`. */
export type RoleModels = Partial<Record<ModelRole, BaseChatModel>>;

/**
 * The providers a role can be assigned. These are *data* (just names) — core
 * never instantiates an SDK; the runtime (`@arzonic/agent-shared`) maps a spec to
 * a concrete model. Kept here so the persisted/over-the-wire mission config and
 * the runtime resolver share one source of truth. anthropic = Claude, google = Gemini.
 */
export const MODEL_PROVIDERS = ["mistral", "anthropic", "google"] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

/** One role's model assignment as plain config data: `{ provider, model?, temperature? }`. */
export const ModelSpecSchema = z.object({
  provider: z.enum(MODEL_PROVIDERS),
  model: z.string().min(1).optional(),
  /**
   * Sampling temperature, 0 (deterministic — e.g. a critic) … 2. Omitted = the
   * runtime default. Provider-clamped. Newer Claude models (Opus 4.7/4.8, Fable)
   * reject any temperature ≠ 1 — they're steered by prompting/effort — so the
   * runtime resolver drops it for them rather than letting the call fail.
   */
  temperature: z.number().min(0).max(2).optional(),
});
export type ModelSpec = z.infer<typeof ModelSpecSchema>;

/**
 * A per-role model config (role → spec) — the shape persisted on a mission and
 * sent over the API to pick each "team member's" model. Unknown role keys are
 * rejected so a typo can't silently misconfigure the team. This is config DATA;
 * the runtime turns it into `RoleModels` (live model instances) via `buildRoleModels`.
 */
export const RoleModelsConfigSchema = z
  .record(z.string(), ModelSpecSchema)
  .superRefine((obj, ctx) => {
    for (const key of Object.keys(obj)) {
      if (!(MODEL_ROLES as readonly string[]).includes(key)) {
        ctx.addIssue({
          code: "custom",
          message: `unknown role '${key}' (valid: ${MODEL_ROLES.join(", ")})`,
        });
      }
    }
  });
export type RoleModelsConfig = Partial<Record<ModelRole, ModelSpec>>;

/**
 * Resolve the model for a role: the per-role override if one is configured,
 * otherwise the fallback (`model`). This is the single resolution point every
 * graph uses, so "configure the critic to use Gemini" is one map entry away.
 */
export function pickModel(
  fallback: BaseChatModel,
  role: ModelRole,
  models?: RoleModels,
): BaseChatModel {
  return models?.[role] ?? fallback;
}

/**
 * Merge ordered role-model config layers into one, later layers winning per role.
 * The precedence ladder a mission resolves through — env baseline ‹ global default
 * (DB) ‹ project default ‹ the mission's own picks — is exactly this shallow merge
 * in order. `undefined`/empty layers are skipped so callers can pass optionals
 * straight in. Pure config data in, pure config data out (no SDK), so it lives
 * beside `pickModel`; the runtime turns the result into live models later.
 */
export function mergeRoleModels(
  ...layers: (RoleModelsConfig | undefined)[]
): RoleModelsConfig {
  const out: RoleModelsConfig = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const role of Object.keys(layer) as ModelRole[]) {
      const spec = layer[role];
      if (spec) out[role] = spec;
    }
  }
  return out;
}
