import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

const EnvSchema = z
  .object({
    LLM_PROVIDER: z.enum(["mistral", "anthropic"]).default("mistral"),
    LLM_MODEL: z.string().min(1).optional(),
    MISTRAL_API_KEY: z.string().min(1).optional(),
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    SUPABASE_URL: z.url().optional(),
    SUPABASE_SERVICE_KEY: z.string().min(1).optional(),
    SUPABASE_DB_URL: z.string().min(1).optional(),
    MAX_ROUNDS: z.coerce.number().int().min(1).default(3),
    RUN_TOKEN_BUDGET: z.coerce.number().int().min(1).optional(),
    RUN_TIMEOUT_MS: z.coerce.number().int().min(1).default(300_000),
    LANGSMITH_TRACING: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    LANGSMITH_API_KEY: z.string().min(1).optional(),
  })
  .superRefine((env, ctx) => {
    if (env.LLM_PROVIDER === "mistral" && !env.MISTRAL_API_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["MISTRAL_API_KEY"],
        message: "MISTRAL_API_KEY is required when LLM_PROVIDER=mistral",
      });
    }
    if (env.LLM_PROVIDER === "anthropic" && !env.ANTHROPIC_API_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["ANTHROPIC_API_KEY"],
        message: "ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic",
      });
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

export function loadEnv(): Env {
  const envFile = findEnvFile(process.cwd());
  if (envFile) loadDotenv({ path: envFile, quiet: true });

  const parsed = EnvSchema.safeParse(process.env);
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
