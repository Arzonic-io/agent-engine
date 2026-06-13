import { loadEnv, type Env } from "@arzonic/agent-shared";
import { z } from "zod";

const ApiEnvSchema = z.object({
  AGENT_API_KEY: z
    .string()
    .min(16, "AGENT_API_KEY must be at least 16 characters"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  API_CORS_ORIGINS: z
    .string()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean),
    ),
});

export type ApiEnv = Env & z.infer<typeof ApiEnvSchema>;

export function loadApiEnv(): ApiEnv {
  const base = loadEnv();
  const parsed = ApiEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid API environment configuration:\n${details}`);
  }
  if (!base.SUPABASE_DB_URL) {
    console.warn(
      "[agent-api] SUPABASE_DB_URL is not set — falling back to the in-memory " +
        "checkpointer. Runs will NOT survive a restart. Set it in production.",
    );
  }
  return { ...base, ...parsed.data };
}
