import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { concatMap, from, interval, startWith, takeWhile, type Observable } from "rxjs";
import {
  approveParkedItem,
  buildDigest,
  classifyRisk,
  mergeRoleModels,
  rejectParkedItem,
  resumeMissionIfBlocked,
  RoleModelsConfigSchema,
  type RoleModelsConfig,
} from "@arzonic/agent-core";
import type {
  BacklogItem,
  BacklogService,
  MemoryService,
  UsageSummary,
} from "@arzonic/agent-shared";
import type {
  ApiDiff,
  ApiMessage,
  MissionDetail,
  MissionItemActivity,
  MissionItemDecisionResponse,
  MissionStreamEvent,
  MissionSummary,
  StopMissionResponse,
} from "@arzonic/agent-client";
import type { ApiEnv } from "../env.js";
import type { CheckpointerHandle } from "../checkpointer.js";
import { BACKLOG, CHECKPOINTER, ENV, MEMORY, USAGE } from "../tokens.js";
import type { UsageHandle } from "../usage.provider.js";
import { assertProvidersConfigured } from "../role-models.util.js";
import { RunsService } from "../runs/runs.service.js";
import type { CreateMissionDto, MissionItemDecisionDto } from "./missions.dto.js";

/** A mission is terminal once it can no longer be fed work — its team is then frozen. */
const TERMINAL_MISSION_STATUSES = new Set(["done", "failed", "stopped"]);

/** How often the SSE stream re-reads mission state and pushes a snapshot. */
const SNAPSHOT_INTERVAL_MS = 2000;

/** How many trailing agent messages the live feed gets per poll — recent steps, not the transcript. */
const ACTIVITY_TAIL = 20;

/**
 * Board summaries of each item's diff: the file rollup (paths, ±lines, truncated
 * flag) the dashboard renders, WITHOUT the potentially 100KB unified `patch`.
 * The board re-reads this every {@link SNAPSHOT_INTERVAL_MS} for the life of an
 * open dashboard, so re-shipping every parked item's full patch each tick would
 * balloon the SSE frames on a "runs all night" mission. The patch is lazy-loaded
 * per item via {@link MissionsService.itemDiff} only when a human expands it.
 */
function summariseItemDiffs(items: BacklogItem[]): BacklogItem[] {
  return items.map((it) =>
    it.diff ? { ...it, diff: { ...it.diff, patch: "" } } : it,
  );
}

@Injectable()
export class MissionsService {
  constructor(
    @Inject(BACKLOG) private readonly backlog: BacklogService | null,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(MEMORY) private readonly memory: MemoryService | null,
    @Inject(CHECKPOINTER) private readonly checkpointer: CheckpointerHandle,
    @Inject(RunsService) private readonly runs: RunsService,
    @Inject(USAGE) private readonly usageHandle: UsageHandle | null,
  ) {}

  private require(): BacklogService {
    if (!this.backlog) {
      throw new BadRequestException(
        "Missions need a database — set SUPABASE_DB_URL.",
      );
    }
    return this.backlog;
  }

  /**
   * A project's stored default team config — the team new missions inherit.
   * Defensively parsed: a malformed settings blob yields no default rather than
   * a 500, and an absent memory service (no DB/embeddings) simply means none.
   */
  /**
   * A mission's verification checks must be a subset of the server's
   * REPO_ALLOWED_CHECKS allowlist — otherwise the Verifier would silently return
   * "not allowed" (never done) at run time. Reject up front with a clear 400.
   */
  private assertChecksAllowed(checks: string[]): void {
    const allowed = new Set(this.env.REPO_ALLOWED_CHECKS);
    const bad = checks.filter((c) => !allowed.has(c));
    if (bad.length > 0) {
      throw new BadRequestException(
        `Ukendte checks: ${bad.join(", ")}. Tilladte: ${this.env.REPO_ALLOWED_CHECKS.join(", ")}.`,
      );
    }
  }

  private async projectTeamDefault(projectId: string): Promise<RoleModelsConfig> {
    if (!this.memory) return {};
    const project = await this.memory.getProject(projectId);
    const parsed = RoleModelsConfigSchema.safeParse(project?.settings?.roleModels ?? {});
    return parsed.success ? (parsed.data as RoleModelsConfig) : {};
  }

  async create(dto: CreateMissionDto): Promise<MissionDetail> {
    const backlog = this.require();
    const repoPath = this.runs.validateRepoPath(dto.repoPath);
    // Creation-time inheritance (like the repo): the mission folds the project's
    // default team under its own picks, so unpinned roles get the project default
    // and the mission's choices win. The worker then layers the global default
    // (DB) + env baseline below this — net precedence: mission > project > global > env.
    const projectDefault = await this.projectTeamDefault(dto.projectId);
    const roleModels = mergeRoleModels(projectDefault, dto.roleModels);
    assertProvidersConfigured(this.env, roleModels);
    const checks = dto.checks ?? [];
    if (checks.length > 0) this.assertChecksAllowed(checks);
    const mission = await backlog.createMission({
      projectId: dto.projectId,
      goal: dto.goal,
      repoPath,
      acceptanceCriteria: dto.acceptanceCriteria ?? [],
      // Empty here = the worker falls back to its MISSION_CHECKS env default.
      checks,
      budget: dto.budget ?? null,
      deadline: dto.deadline ?? null,
      roleModels,
      guidance: dto.guidance ?? null,
      issueNumber: dto.issueNumber ?? null,
    });
    // Seed the initial backlog, classifying risk up front so the board shows it
    // (the controller re-checks at run-time too — this is just for visibility).
    for (const it of dto.items ?? []) {
      await backlog.createItem({
        missionId: mission.id,
        title: it.title,
        detail: it.detail,
        priority: it.priority,
        dependsOn: it.dependsOn,
        risk: classifyRisk(it, this.env.MISSION_HIGH_RISK_PATTERNS),
      });
    }
    return this.detail(mission.id);
  }

  async list(): Promise<MissionSummary[]> {
    return (await this.require().listMissions()) as MissionSummary[];
  }

  async get(id: string): Promise<MissionDetail> {
    return this.detail(id);
  }

  private async detail(id: string): Promise<MissionDetail> {
    const backlog = this.require();
    const mission = await backlog.getMission(id);
    if (!mission) throw new NotFoundException(`No mission ${id}`);
    const items = summariseItemDiffs(await backlog.listItems(id));
    const digest = buildDigest(mission, items, this.env.MISSION_HIGH_RISK_PATTERNS);
    return { ...mission, items, digest } as MissionDetail;
  }

  /**
   * The full authored diff for one item — WITH the unified patch. The board's
   * snapshot stream ships patch-free summaries (see `summariseItemDiffs`), so the
   * dashboard lazy-loads the patch through here only when a human expands an item.
   * Null if the item hasn't authored a diff yet.
   */
  async itemDiff(missionId: string, itemId: string): Promise<ApiDiff | null> {
    const backlog = this.require();
    const item = await backlog.getItem(itemId);
    if (!item || item.missionId !== missionId) {
      throw new NotFoundException(`No item ${itemId} on mission ${missionId}`);
    }
    return (item.diff as ApiDiff | null) ?? null;
  }

  /** What a mission's model calls cost — per role, per item and per finished item. */
  async usage(missionId: string): Promise<UsageSummary> {
    const backlog = this.require();
    if (!(await backlog.getMission(missionId))) {
      throw new NotFoundException(`No mission ${missionId}`);
    }
    if (!this.usageHandle) {
      throw new BadRequestException(
        "Model usage is not measured on this server — no database, or the usage ledger failed to start (see the API log).",
      );
    }
    return this.usageHandle.ledger.missionSummary(missionId);
  }

  /**
   * Live activity for one item: the agent-message tail from its checkpointed run
   * (thread_id = item id) — what the dashboard's live feed polls while an item is
   * in progress. The worker checkpoints every graph step to the shared Postgres,
   * so reading the tuple here needs no compiled graph and never touches the
   * worker process. Best-effort by design: a missing/unreadable checkpoint (item
   * not started yet, in-memory saver) is an empty feed, not an error.
   */
  async itemActivity(missionId: string, itemId: string): Promise<MissionItemActivity> {
    const backlog = this.require();
    const item = await backlog.getItem(itemId);
    if (!item || item.missionId !== missionId) {
      throw new NotFoundException(`No item ${itemId} on mission ${missionId}`);
    }
    let messages: ApiMessage[] = [];
    let round = 0;
    try {
      const tuple = await this.checkpointer.saver.getTuple({
        configurable: { thread_id: itemId },
      });
      const values = (tuple?.checkpoint?.channel_values ?? {}) as {
        messages?: unknown;
        round?: unknown;
      };
      const raw = Array.isArray(values.messages) ? values.messages : [];
      messages = raw
        .filter(
          (m): m is ApiMessage =>
            !!m &&
            typeof m === "object" &&
            typeof (m as { content?: unknown }).content === "string" &&
            typeof (m as { agent?: unknown }).agent === "string",
        )
        .slice(-ACTIVITY_TAIL);
      if (typeof values.round === "number") round = values.round;
    } catch {
      // Feed is decoration on top of the board — never fail the poll on it.
    }
    const last = messages[messages.length - 1];
    return { itemId, status: item.status, agent: last?.agent ?? null, round, messages };
  }

  /**
   * Course-correct a non-terminal mission with free-text guidance (M3 Trin 6). It
   * flows into the next replan/decompose context on the worker's next pass — a steer
   * beyond Stop that never blocks the loop. Empty string clears it.
   */
  async updateGuidance(id: string, guidance: string | null): Promise<MissionDetail> {
    const backlog = this.require();
    const mission = await backlog.getMission(id);
    if (!mission) throw new NotFoundException(`No mission ${id}`);
    if (TERMINAL_MISSION_STATUSES.has(mission.status)) {
      throw new ConflictException(
        `Mission ${id} is ${mission.status} — guidance no longer affects it.`,
      );
    }
    const trimmed = guidance?.trim();
    await backlog.updateMission(id, { guidance: trimmed ? trimmed : null });
    return this.detail(id);
  }

  /**
   * Re-point a non-terminal mission's team mid-flight. The worker rebuilds this
   * mission's agents from the row on each pass, so the change takes effect on the
   * next planning/execution round — not the item currently in flight. Providers
   * are validated server-side exactly as at creation.
   */
  async updateRoleModels(id: string, roleModels: RoleModelsConfig): Promise<MissionDetail> {
    const backlog = this.require();
    const mission = await backlog.getMission(id);
    if (!mission) throw new NotFoundException(`No mission ${id}`);
    if (TERMINAL_MISSION_STATUSES.has(mission.status)) {
      throw new ConflictException(
        `Mission ${id} is ${mission.status} — its team can no longer be changed.`,
      );
    }
    assertProvidersConfigured(this.env, roleModels);
    await backlog.updateMission(id, { roleModels });
    return this.detail(id);
  }

  /**
   * Re-point a non-terminal mission's verification checks mid-flight. The worker
   * reads the row on each pass, so the change applies to the next item verified.
   * Validated against the allowlist exactly as at creation.
   */
  async updateChecks(id: string, checks: string[]): Promise<MissionDetail> {
    const backlog = this.require();
    const mission = await backlog.getMission(id);
    if (!mission) throw new NotFoundException(`No mission ${id}`);
    if (TERMINAL_MISSION_STATUSES.has(mission.status)) {
      throw new ConflictException(
        `Mission ${id} is ${mission.status} — its checks can no longer be changed.`,
      );
    }
    if (checks.length > 0) this.assertChecksAllowed(checks);
    await backlog.updateMission(id, { checks });
    return this.detail(id);
  }

  /**
   * Update a mission's token budget — typically raised so a budget-stopped
   * mission can be resumed with headroom. Deliberately NOT gated on terminal
   * status: topping up a stopped mission is the whole point (the worker
   * re-reads the row's budget on every pass, so a raise on a running mission
   * also takes effect immediately). Null clears the cap.
   */
  async updateBudget(id: string, budget: number | null): Promise<MissionDetail> {
    const backlog = this.require();
    const mission = await backlog.getMission(id);
    if (!mission) throw new NotFoundException(`No mission ${id}`);
    await backlog.updateMission(id, { budget });
    return this.detail(id);
  }

  /**
   * Resume a stopped/blocked mission (a budget stop is the prime case). Parked
   * and failed items are re-queued to `todo` with their stale verification
   * cleared, so the board doesn't show a "failed check" on work that hasn't
   * re-run yet. Risk is deliberately kept: a high-risk item still parks at the
   * pre-run gate — resume is not a blanket approval (that's `decideItem`).
   * The worker only scans `running` missions, so flipping status + clearing
   * stop_reason is what actually puts it back in the loop. Note a budget-stopped
   * mission resumed WITHOUT a raised budget re-stops on its next governor check.
   */
  async resume(id: string): Promise<MissionDetail> {
    const backlog = this.require();
    const mission = await backlog.getMission(id);
    if (!mission) throw new NotFoundException(`No mission ${id}`);
    if (mission.status !== "stopped" && mission.status !== "blocked") {
      throw new ConflictException(
        `Mission ${id} is ${mission.status} — only stopped or blocked missions can be resumed.`,
      );
    }
    // Items first, mission-status last: the worker must never see a `running`
    // mission whose backlog is still all-parked (it would instantly re-block).
    const items = await backlog.listItems(id);
    for (const it of items) {
      if (it.status === "blocked_needs_human" || it.status === "failed") {
        await backlog.updateItem(it.id, { status: "todo", verification: null });
      }
    }
    // Same invariant for the clock: a deadline already in the past re-stops the
    // mission on the governor's first check, so resuming under it is a silent
    // no-op — and unlike the budget there is no endpoint to extend it. Resuming
    // after expiry IS the decision to keep going, so drop the spent deadline and
    // let the budget govern. A future deadline is left alone.
    const deadlineExpired = mission.deadline !== null && Date.parse(mission.deadline) <= Date.now();
    await backlog.updateMission(id, {
      status: "running",
      stopReason: null,
      ...(deadlineExpired ? { deadline: null } : {}),
    });
    return this.detail(id);
  }

  /** Kill switch: the worker halts at its next checkpoint (status != running). */
  async stop(id: string): Promise<StopMissionResponse> {
    const backlog = this.require();
    const mission = await backlog.getMission(id);
    if (!mission) throw new NotFoundException(`No mission ${id}`);
    const updated = await backlog.updateMission(id, { status: "stopped" });
    return { missionId: id, status: (updated ?? mission).status };
  }

  async remove(id: string): Promise<void> {
    const backlog = this.require();
    const mission = await backlog.getMission(id);
    if (!mission) throw new NotFoundException(`No mission ${id}`);
    await backlog.deleteMission(id); // backlog_items cascade via the FK
  }

  async decideItem(
    missionId: string,
    itemId: string,
    dto: MissionItemDecisionDto,
  ): Promise<MissionItemDecisionResponse> {
    const backlog = this.require();
    const item = await backlog.getItem(itemId);
    if (!item || item.missionId !== missionId) {
      throw new NotFoundException(`No item ${itemId} on mission ${missionId}`);
    }
    if (item.status !== "blocked_needs_human") {
      throw new ConflictException(
        `Item ${itemId} is not parked (status: ${item.status})`,
      );
    }
    // Carry the human's note into the item itself, so an approved item is
    // re-attempted WITH the correction rather than identically to the attempt
    // that got parked. Written before the status flip so the worker can never
    // pick the item up between the two writes and miss it.
    const note = dto.notes?.trim();
    if (note) {
      await backlog.updateItem(itemId, {
        detail: `${item.detail}\n\nNote fra mennesket: ${note}`.trim(),
      });
    }
    const updated =
      dto.decision === "approve"
        ? await approveParkedItem(backlog, itemId)
        : await rejectParkedItem(backlog, itemId);
    // Re-queuing the item isn't enough on approve: if the controller already
    // parked the whole mission (status "blocked") because every remaining item
    // was awaiting a human, the PM2 worker — which scans only "running" missions —
    // would never re-pick it, so the approved work would silently never resume.
    // Flip blocked → running. A no-op for a human-stopped/paused or terminal
    // mission (the helper guards that), and reject never resurrects.
    if (dto.decision === "approve") {
      await resumeMissionIfBlocked(backlog, missionId);
    }
    return { itemId, status: (updated ?? item).status };
  }

  /** Periodic state snapshots for the dashboard, until the mission is terminal. */
  stream(id: string): Observable<MissionStreamEvent> {
    this.require();
    return interval(SNAPSHOT_INTERVAL_MS).pipe(
      startWith(0),
      concatMap(() => from(this.snapshot(id))),
      // Keep streaming while active; emit the first terminal snapshot, then end.
      takeWhile(
        (e) =>
          e.type === "snapshot" &&
          (e.mission.status === "running" || e.mission.status === "paused"),
        true,
      ),
    );
  }

  private async snapshot(id: string): Promise<MissionStreamEvent> {
    try {
      // `detail()` already strips per-item patches (summariseItemDiffs), so the
      // periodic snapshot carries only the board summary — never the full patch.
      const { items, digest, ...mission } = await this.detail(id);
      return { type: "snapshot", mission, items, digest };
    } catch (err) {
      return { type: "error", message: err instanceof Error ? err.message : String(err) };
    }
  }
}
