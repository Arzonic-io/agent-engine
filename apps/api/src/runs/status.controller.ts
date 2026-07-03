import { Controller, Get, Inject } from "@nestjs/common";
import type { BacklogService, MemoryService } from "@arzonic/agent-shared";
import type { ApiEnv } from "../env.js";
import { BACKLOG, ENV, MEMORY } from "../tokens.js";

/** Which server-side capabilities are configured — lets the UI show a clear
 * "activate project memory" state instead of a raw 503 when the DB/keys are
 * missing (memory needs SUPABASE_DB_URL + MISTRAL_API_KEY; missions need the DB).
 * Also exposes the verification-check allowlist so the mission composer can offer
 * real check choices, and whether LangSmith tracing is on so the UI can link it. */
export type ApiStatus = {
  memory: boolean;
  missions: boolean;
  /** Tracing is on when LANGSMITH_TRACING=true + an API key is set. */
  tracing: boolean;
  /** Blended $/1M-token rate for an estimated cost readout, or null if unconfigured. */
  costPerMtok: number | null;
  checks: {
    /** Named pnpm scripts a mission may run (REPO_ALLOWED_CHECKS). */
    allowed: string[];
    /** The default set applied when a mission pins none (MISSION_CHECKS). */
    default: string[];
  };
};

@Controller("status")
export class StatusController {
  constructor(
    @Inject(MEMORY) private readonly memory: MemoryService | null,
    @Inject(BACKLOG) private readonly backlog: BacklogService | null,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  @Get()
  get(): ApiStatus {
    return {
      memory: this.memory !== null,
      missions: this.backlog !== null,
      tracing: this.env.LANGSMITH_TRACING === true && !!this.env.LANGSMITH_API_KEY,
      costPerMtok: this.env.LLM_COST_PER_MTOK ?? null,
      checks: { allowed: this.env.REPO_ALLOWED_CHECKS, default: this.env.MISSION_CHECKS },
    };
  }
}
