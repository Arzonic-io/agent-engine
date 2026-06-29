import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  MODEL_PROVIDERS,
  RoleModelsConfigSchema,
  type ModelProvider,
  type ModelSpec,
  type RoleModelsConfig,
} from "@arzonic/agent-core";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

// Provider/spec/config shapes are defined once in pure core (data only) and
// re-exported here for the runtime. anthropic = Claude, google = Gemini.
export const LLM_PROVIDERS = MODEL_PROVIDERS;
export type LlmProvider = ModelProvider;
/** Back-compat alias — a role's `{ provider, model? }` assignment. */
export type RoleModelSpec = ModelSpec;
export type { RoleModelsConfig };

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
    // Prompt caching (M3 Trin 4) — Anthropic only. When on, every Claude call gets
    // a top-level ephemeral cache breakpoint that the API auto-places on the last
    // cacheable block and advances as the conversation grows. The big win is the
    // implementer/tester ReAct loop, where tools + system prompt + the growing
    // transcript are re-read from cache (~0.1x) each tool round-trip instead of
    // reprocessed at full price. Pure cost reduction, no behaviour change; default on.
    LLM_PROMPT_CACHE: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
    MISTRAL_API_KEY: z.string().min(1).optional(),
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    GOOGLE_API_KEY: z.string().min(1).optional(),
    // Vertex AI via Application Default Credentials (ADC) — set a GCP project to use
    // Gemini WITHOUT an API key (gcloud auth). When GOOGLE_CLOUD_PROJECT is set the
    // google provider routes through Vertex (@langchain/google-vertexai); otherwise
    // it uses the API-key Gemini SDK.
    GOOGLE_CLOUD_PROJECT: z.string().min(1).optional(),
    GOOGLE_CLOUD_LOCATION: z.string().min(1).default("europe-west4"),
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
    // Drift-robustness (M3 Trin 3): how many times a model call retries a TRANSIENT
    // error (rate-limit/5xx/timeout) with exponential backoff + jitter, via the
    // provider's AsyncCaller. 0 = no retry. Survives a long night of API blips.
    MISSION_LLM_MAX_RETRIES: z.coerce.number().int().min(0).default(6),
    // How many times the controller re-queues an item whose run throws a TRANSIENT
    // infra error before parking it as blocked_needs_human (so a persistent outage
    // still terminates). Kept separate from the thrash (logic-failure) budget.
    // Default 2 (< MISSION_NOPROGRESS_LIMIT) so a sustained outage parks the item
    // with a recorded "gave up after N retries" note rather than tripping the
    // coarser no-progress stop first; raise it above no-progress to prefer a
    // resumable stop over an infra-park.
    MISSION_REQUEUE_LIMIT: z.coerce.number().int().min(1).default(2),
    // Adversarial review cycles per item (M3 ★): the critic challenges the
    // implementer's diff, looping back for revision on a fail. 0 = no review
    // (lone implementer, pre-★ behaviour); 1 = one review + one revision.
    MISSION_REVIEW_ROUNDS: z.coerce.number().int().min(0).default(1),
    // Author a test that exercises each item before verification (M3 Trin 2), so
    // "green" means a real test passed, not just that it compiles. Off by default
    // (= pre-Trin-2 behaviour). Pair with a "test" check in MISSION_CHECKS, and
    // assign the `tester` role in LLM_ROLE_MODELS to pick its model.
    MISSION_AUTHOR_TESTS: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
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
    // ── overnight trust: out-of-band notification + preemption + self-direction ──
    // (blocker 1) Webhook the mission-worker POSTs parked-item / digest / stopped
    // events to, so a sleeping human is actually reachable. Slack/Discord/Mattermost
    // incoming webhooks work directly (they render the top-level `text`). Unset = off.
    MISSION_NOTIFY_WEBHOOK_URL: z.url().optional(),
    // (blocker 1) Push a mid-run digest of every running mission this often, so a
    // still-running overnight mission reports before morning instead of only at the
    // end. Unset = off (only the terminal digest fires). Min 1 min.
    MISSION_DIGEST_INTERVAL_MS: z.coerce.number().int().min(60_000).optional(),
    // (blocker 2) How often the worker's watcher re-reads mission status/deadline/
    // budget to ABORT an in-flight run, so Stop + the deadline actually preempt
    // work mid-item instead of only biting between batches.
    MISSION_ABORT_POLL_MS: z.coerce.number().int().min(500).default(3000),
    // (blocker 3) How many times a mission may strategically re-decompose when its
    // backlog drains but the goal isn't met — letting an overnight run self-direct
    // toward the goal instead of stopping the instant the initial plan empties.
    // 0 = off (drain-and-stop). Every other governor still bounds the run.
    MISSION_MAX_STRATEGIC_REPLANS: z.coerce.number().int().min(0).default(3),
    // ── overnight trust "del b": publish the work as a reviewable PR ──
    // Fine-grained GitHub PAT (Contents + Pull-requests: write on the target repos).
    // When set (and MISSION_PUBLISH_PR is on), a finished mission pushes its
    // integration branch to `origin` and opens a PR against the default branch.
    // Unset = no publish (work stays on the local branch). The token is embedded in
    // the push URL + REST header and SCRUBBED from every log line.
    GITHUB_TOKEN: z.string().min(1).optional(),
    // Master switch for the publish step — on by default, so a present token
    // publishes. Set false to keep the token configured but pause publishing.
    MISSION_PUBLISH_PR: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
    // Open the PR as a draft (default true): CI can run while a human reviews and
    // marks it ready. False opens a ready-for-review PR immediately.
    MISSION_PR_DRAFT: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
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
      // Gemini works via EITHER an API key (google-genai) OR Vertex AI ADC
      // (GOOGLE_CLOUD_PROJECT, no key). Accept the role as long as one is present.
      if (provider === "google") {
        if (!env.GOOGLE_API_KEY && !env.GOOGLE_CLOUD_PROJECT) {
          ctx.addIssue({
            code: "custom",
            path: ["GOOGLE_CLOUD_PROJECT"],
            message:
              "When a role uses provider=google, set GOOGLE_CLOUD_PROJECT (Vertex AI / ADC, no key) or GOOGLE_API_KEY",
          });
        }
        continue;
      }
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
