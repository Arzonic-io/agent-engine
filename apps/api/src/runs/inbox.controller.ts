import { Controller, Get, Inject, Optional } from "@nestjs/common";
import type { BacklogService } from "@arzonic/agent-shared";
import type { Inbox } from "@arzonic/agent-client";
import { ProjectsService } from "../projects/projects.service.js";
import { BACKLOG } from "../tokens.js";

/**
 * Everything waiting on a human, across every project, in one call — runs
 * paused at the gate plus mission items parked for a decision. Answers the
 * operator's first question ("what needs me?"), which previously required
 * opening each run and each mission separately.
 *
 * Degrades rather than fails: with memory or missions disabled the
 * corresponding half comes back empty instead of 503-ing the whole inbox.
 */
@Controller("inbox")
export class InboxController {
  constructor(
    @Inject(ProjectsService) private readonly projects: ProjectsService,
    @Optional() @Inject(BACKLOG) private readonly backlog: BacklogService | null,
  ) {}

  @Get()
  async get(): Promise<Inbox> {
    const [tasks, items] = await Promise.all([
      this.projects
        .listRecent()
        .then((all) => all.filter((t) => t.status === "awaiting_human"))
        .catch(() => []),
      this.backlog?.listBlockedItems().catch(() => []) ?? [],
    ]);
    return { tasks, items };
  }
}
