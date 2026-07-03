import { Controller, Get, Inject } from "@nestjs/common";
import type { BacklogService, MemoryService } from "@arzonic/agent-shared";
import { BACKLOG, MEMORY } from "../tokens.js";

/** Which server-side capabilities are configured — lets the UI show a clear
 * "activate project memory" state instead of a raw 503 when the DB/keys are
 * missing (memory needs SUPABASE_DB_URL + MISTRAL_API_KEY; missions need the DB). */
export type ApiStatus = { memory: boolean; missions: boolean };

@Controller("status")
export class StatusController {
  constructor(
    @Inject(MEMORY) private readonly memory: MemoryService | null,
    @Inject(BACKLOG) private readonly backlog: BacklogService | null,
  ) {}

  @Get()
  get(): ApiStatus {
    return { memory: this.memory !== null, missions: this.backlog !== null };
  }
}
