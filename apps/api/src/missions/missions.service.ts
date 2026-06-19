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
  rejectParkedItem,
  resumeMissionIfBlocked,
} from "@arzonic/agent-core";
import type { BacklogService } from "@arzonic/agent-shared";
import type {
  MissionDetail,
  MissionItemDecisionResponse,
  MissionStreamEvent,
  MissionSummary,
  StopMissionResponse,
} from "@arzonic/agent-client";
import type { ApiEnv } from "../env.js";
import { BACKLOG, ENV } from "../tokens.js";
import { RunsService } from "../runs/runs.service.js";
import type { CreateMissionDto, MissionItemDecisionDto } from "./missions.dto.js";

/** How often the SSE stream re-reads mission state and pushes a snapshot. */
const SNAPSHOT_INTERVAL_MS = 2000;

@Injectable()
export class MissionsService {
  constructor(
    @Inject(BACKLOG) private readonly backlog: BacklogService | null,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(RunsService) private readonly runs: RunsService,
  ) {}

  private require(): BacklogService {
    if (!this.backlog) {
      throw new BadRequestException(
        "Missions need a database — set SUPABASE_DB_URL.",
      );
    }
    return this.backlog;
  }

  async create(dto: CreateMissionDto): Promise<MissionDetail> {
    const backlog = this.require();
    const repoPath = this.runs.validateRepoPath(dto.repoPath);
    const mission = await backlog.createMission({
      projectId: dto.projectId,
      goal: dto.goal,
      repoPath,
      acceptanceCriteria: dto.acceptanceCriteria ?? [],
      budget: dto.budget ?? null,
      deadline: dto.deadline ?? null,
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
    const items = await backlog.listItems(id);
    const digest = buildDigest(mission, items);
    return { ...mission, items, digest } as MissionDetail;
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
      const { items, digest, ...mission } = await this.detail(id);
      return { type: "snapshot", mission, items, digest };
    } catch (err) {
      return { type: "error", message: err instanceof Error ? err.message : String(err) };
    }
  }
}
