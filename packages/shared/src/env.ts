import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { MODEL_ROLES, type ModelRole } from "@arzonic/agent-core";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

/** LLM providers a team member can be assigned. Claude = anthropic, Gemini = google. */
export const LLM_PROVIDERS = ["mistral", "anthropic", "google"] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

/** One team member's model assignment — `{ provider, model? }`; model defaults per provider. */
const RoleModelSpecSchema = z.object({
  provider: z.enum(LLM_PROVIDERS),
  model: z.string().min(1).optional(),
});
export type RoleModelSpec = z.infer<typeof RoleModelSpecSchema>;

/**
 * `LLM_ROLE_MODELS` is a JSON map of role → { provider, model? }, e.g.
 *   {"architect":{"provider":"mistral"},"critic":{"provider":"google","model":"gemini-2.0-flash"},
 *    "implementer":{"provider":"anthropic","model":"claude-sonnet-4-6"}}
 * Unknown roles are rejected so a typo can't silently misconfigure the team.
 */
const RoleModelsConfigSchema = z
  .record(z.string(), RoleModelSpecSchema)
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
export type RoleModelsConfig = Partial<Record<ModelRole, RoleModelSpec>>;

const EnvSchema = z
  .object({
    LLM_PROVIDER: z.enum(LLM_PROVIDERS).default("mistral"),
    LLM_MODEL: z.string().min(1).optional(),
    // Per-role model assignments (the configurable "team members"). JSON; empty = one model everywhere.
    LLM_ROLE_MODELS: z
      .string()
      .optional()
      .transform((s, ctx): unknown => {
        if (!s) return undefined;
        try {
          return JSON.parse(s);
        } catch {
          ctx.addIssue({ code: "custom", message: "LLM_ROLE_MODELS must be valid JSON" });
          return z.NEVER;
        }
      })
      .pipe(RoleModelsConfigSchema.optional()),
    MISTRAL_API_KEY: z.string().min(1).optional(),
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    GOOGLE_API_KEY: z.string().min(1).optional(),
    SUPABASE_URL: z.url().optional(),
    SUPABASE_SERVICE_KEY: z.string().min(1).optional(),
    SUPABASE_DB_URL: z.string().min(1).optional(),
    MAX_ROUNDS: z.coerce.number().int().min(1).default(3),
    RUN_TOKEN_BUDGET: z.coerce.number().int().min(1).optional(),
    RUN_TIMEOUT_MS: z.coerce.number().int().min(1).default(300_000),
    // Commands an agent is allowed to run via the run_check tool (Layer 2).
    REPO_ALLOWED_CHECKS: z
      .string()
      .default("test,lint,typecheck,build")
      .transform((s) =>
        s
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
      ),
    // Executables an autonomous mission may run via runCommand (M2, no shell).
    REPO_ALLOWED_COMMANDS: z
      .string()
      .default("git,node,pnpm,npm,npx")
      .transform((s) =>
        s
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
      ),
    LANGSMITH_TRACING: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    LANGSMITH_API_KEY: z.string().min(1).optional(),
    // ── autonomous missions (§5 / §10) ──
    MISSION_TOKEN_BUDGET: z.coerce.number().int().min(1).optional(),
    MISSION_MAX_ITERATIONS: z.coerce.number().int().min(1).optional(),
    MISSION_NOPROGRESS_LIMIT: z.coerce.number().int().min(1).default(3),
    MISSION_THRASH_LIMIT: z.coerce.number().int().min(1).default(3),
    // Items run concurrently per mission (each in its own worktree). Default 1
    // (serial). Integration/merge stays sequential regardless.
    MISSION_CONCURRENCY: z.coerce.number().int().min(1).default(1),
    // Checks the mission Verifier runs per item — the truth source for "done".
    MISSION_CHECKS: z
      .string()
      .default("typecheck,test")
      .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean)),
    // Extra patterns that force an item to high-risk (parked for a human).
    MISSION_HIGH_RISK_PATTERNS: z
      .string()
      .default("")
      .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean)),
    // How often the mission-worker scans for running missions to drive.
    MISSION_WORKER_POLL_MS: z.coerce.number().int().min(1000).default(5000),
  })
  .superRefine((env, ctx) => {
    // Every provider actually in use — the default plus any per-role override —
    // needs its API key. So configuring just the critic to use Gemini requires
    // GOOGLE_API_KEY, even if the default provider is mistral.
    const used = new Set<LlmProvider>([env.LLM_PROVIDER]);
    for (const spec of Object.values(env.LLM_ROLE_MODELS ?? {})) {
      if (spec) used.add(spec.provider);
    }
    const keyFor: Record<LlmProvider, { key: keyof typeof env; value?: string }> = {
      mistral: { key: "MISTRAL_API_KEY", value: env.MISTRAL_API_KEY },
      anthropic: { key: "ANTHROPIC_API_KEY", value: env.ANTHROPIC_API_KEY },
      google: { key: "GOOGLE_API_KEY", value: env.GOOGLE_API_KEY },
    };
    for (const provider of used) {
      const { key, value } = keyFor[provider];
      if (!value) {
        ctx.addIssue({
          code: "custom",
          path: [key as string],
          message: `${key} is required when a role uses provider=${provider}`,
        });
      }
    }
    if (env.LANGSMITH_TRACING && !env.LANGSMITH_API_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["LANGSMITH_API_KEY"],
        message: "LANGSMITH_API_KEY is required when LANGSMITH_TRACING=true",
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

/** Walk upwards from cwd so `pnpm --filter` runs (cwd = package dir) still find the root .env. */
function findEnvFile(startDir: string): string | undefined {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Treat empty-string env vars as unset. A blank line in .env (e.g. `LLM_MODEL=`)
 * loads as "", which would otherwise fail `.min(1)`/`.url()` on optional fields.
 */
export function cleanEnv(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value !== "") out[key] = value;
  }
  return out;
}

export function loadEnv(): Env {
  const envFile = findEnvFile(process.cwd());
  if (envFile) loadDotenv({ path: envFile, quiet: true });

  const parsed = EnvSchema.safeParse(cleanEnv());
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  if (parsed.data.LANGSMITH_TRACING) {
    // LangChain reads these directly from process.env.
    process.env.LANGSMITH_TRACING = "true";
    process.env.LANGCHAIN_TRACING_V2 = "true";
  }

  return parsed.data;
}
