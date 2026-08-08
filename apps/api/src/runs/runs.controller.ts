import {
  Body,
  Controller,
  Delete,
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
  RerunSchema,
  StartRunSchema,
  ZodValidationPipe,
  type DecisionDto,
  type RerunDto,
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
    // `id:` carries the run's own sequence number so a reconnecting client can
    // recognise the replayed prefix instead of appending it twice. Heartbeats
    // (seq 0) are deliberately id-less — they aren't part of the history.
    return this.runs
      .events(id)
      .pipe(map((event) => (event.seq ? { data: event, id: String(event.seq) } : { data: event })));
  }

  @Delete(":id")
  async remove(@Param("id") id: string): Promise<{ ok: true }> {
    await this.runs.deleteRun(id);
    return { ok: true };
  }

  @Post(":id/decision")
  decide(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(DecisionSchema)) dto: DecisionDto,
  ): Promise<DecisionResponse> {
    return this.runs.decide(id, dto);
  }

  @Post(":id/rerun")
  rerun(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(RerunSchema)) dto: RerunDto,
  ): Promise<StartRunResponse> {
    return this.runs.rerunWithTopology(id, dto.topology);
  }
}
