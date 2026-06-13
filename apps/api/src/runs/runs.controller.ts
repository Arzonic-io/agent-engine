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
  DecisionResponse,
  RunDetail,
  RunSummary,
  StartRunResponse,
} from "@arzonic/agent-client";
import {
  DecisionSchema,
  StartRunSchema,
  ZodValidationPipe,
  type DecisionDto,
  type StartRunDto,
} from "./dto/runs.dto.js";
import { RunsService } from "./runs.service.js";

@Controller("runs")
export class RunsController {
  constructor(@Inject(RunsService) private readonly runs: RunsService) {}

  @Post()
  start(
    @Body(new ZodValidationPipe(StartRunSchema)) dto: StartRunDto,
  ): StartRunResponse {
    return this.runs.start(dto);
  }

  @Get()
  list(): RunSummary[] {
    return this.runs.list();
  }

  @Get(":id")
  getRun(@Param("id") id: string): Promise<RunDetail> {
    return this.runs.getRun(id);
  }

  @Sse(":id/stream")
  stream(@Param("id") id: string): Observable<MessageEvent> {
    return this.runs.events(id).pipe(map((event) => ({ data: event })));
  }

  @Post(":id/decision")
  decide(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(DecisionSchema)) dto: DecisionDto,
  ): Promise<DecisionResponse> {
    return this.runs.decide(id, dto);
  }
}
