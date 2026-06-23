import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Sse,
  type MessageEvent,
} from "@nestjs/common";
import { map, type Observable } from "rxjs";
import type {
  ApiDiff,
  MissionDetail,
  MissionItemDecisionResponse,
  MissionSummary,
  StopMissionResponse,
} from "@arzonic/agent-client";
import { ZodValidationPipe } from "../runs/dto/runs.dto.js";
import {
  CreateMissionSchema,
  MissionItemDecisionSchema,
  UpdateMissionGuidanceSchema,
  UpdateMissionRoleModelsSchema,
  type CreateMissionDto,
  type MissionItemDecisionDto,
  type UpdateMissionGuidanceDto,
  type UpdateMissionRoleModelsDto,
} from "./missions.dto.js";
import { MissionsService } from "./missions.service.js";

@Controller("missions")
export class MissionsController {
  constructor(@Inject(MissionsService) private readonly missions: MissionsService) {}

  @Post()
  create(
    @Body(new ZodValidationPipe(CreateMissionSchema)) dto: CreateMissionDto,
  ): Promise<MissionDetail> {
    return this.missions.create(dto);
  }

  @Get()
  list(): Promise<MissionSummary[]> {
    return this.missions.list();
  }

  @Get(":id")
  get(@Param("id") id: string): Promise<MissionDetail> {
    return this.missions.get(id);
  }

  @Sse(":id/stream")
  stream(@Param("id") id: string): Observable<MessageEvent> {
    return this.missions.stream(id).pipe(map((event) => ({ data: event })));
  }

  @Patch(":id/role-models")
  updateRoleModels(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateMissionRoleModelsSchema)) dto: UpdateMissionRoleModelsDto,
  ): Promise<MissionDetail> {
    return this.missions.updateRoleModels(id, dto.roleModels);
  }

  @Patch(":id/guidance")
  updateGuidance(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateMissionGuidanceSchema)) dto: UpdateMissionGuidanceDto,
  ): Promise<MissionDetail> {
    return this.missions.updateGuidance(id, dto.guidance);
  }

  @Post(":id/stop")
  stop(@Param("id") id: string): Promise<StopMissionResponse> {
    return this.missions.stop(id);
  }

  @Delete(":id")
  async remove(@Param("id") id: string): Promise<{ ok: true }> {
    await this.missions.remove(id);
    return { ok: true };
  }

  /** An item's full authored diff (with patch) — lazy-loaded when a human expands it. */
  @Get(":id/items/:itemId/diff")
  itemDiff(
    @Param("id") id: string,
    @Param("itemId") itemId: string,
  ): Promise<ApiDiff | null> {
    return this.missions.itemDiff(id, itemId);
  }

  @Post(":id/items/:itemId/decision")
  decideItem(
    @Param("id") id: string,
    @Param("itemId") itemId: string,
    @Body(new ZodValidationPipe(MissionItemDecisionSchema)) dto: MissionItemDecisionDto,
  ): Promise<MissionItemDecisionResponse> {
    return this.missions.decideItem(id, itemId, dto);
  }
}
