import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { getModel } from "@arzonic/agent-shared";
import { ApiKeyGuard } from "./auth/api-key.guard.js";
import { createCheckpointer } from "./checkpointer.js";
import { loadApiEnv, type ApiEnv } from "./env.js";
import { RunsController } from "./runs/runs.controller.js";
import { RunsService } from "./runs/runs.service.js";
import { CHECKPOINTER, ENV, MODEL } from "./tokens.js";

@Module({
  controllers: [RunsController],
  providers: [
    { provide: ENV, useFactory: loadApiEnv },
    {
      provide: MODEL,
      useFactory: (env: ApiEnv) => getModel(env),
      inject: [ENV],
    },
    {
      provide: CHECKPOINTER,
      useFactory: (env: ApiEnv) => createCheckpointer(env),
      inject: [ENV],
    },
    RunsService,
    { provide: APP_GUARD, useClass: ApiKeyGuard },
  ],
})
export class AppModule {}
