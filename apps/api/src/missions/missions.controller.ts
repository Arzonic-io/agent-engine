import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Sse,
  type MessageEvent,
} from "@nestjs/common";
import { map, type Observable } from "rxjs";
import type {
  MissionDetail,
  MissionItemDecisionResponse,
  MissionSummary,
  StopMissionResponse,
} from "@arzonic/agent-client";
import { ZodValidationPipe } from "../runs/dto/runs.dto.js";
import {
  CreateMissionSchema,
  MissionItemDecisionSchema,
  type CreateMissionDto,
  type MissionItemDecisionDto,
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

  @Post(":id/stop")
  stop(@Param("id") id: string): Promise<StopMissionResponse> {
    return this.missions.stop(id);
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
