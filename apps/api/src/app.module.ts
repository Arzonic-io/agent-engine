import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { buildRoleModels, getModel } from "@arzonic/agent-shared";
import { ApiKeyGuard } from "./auth/api-key.guard.js";
import { createBacklog } from "./backlog.provider.js";
import { createCheckpointer } from "./checkpointer.js";
import { loadApiEnv, type ApiEnv } from "./env.js";
import { createMemory } from "./memory.provider.js";
import { MissionsController } from "./missions/missions.controller.js";
import { MissionsService } from "./missions/missions.service.js";
import { ProjectsController } from "./projects/projects.controller.js";
import { ProjectsService } from "./projects/projects.service.js";
import { ReposController } from "./runs/repos.controller.js";
import { RubricController } from "./runs/rubric.controller.js";
import { RunsController } from "./runs/runs.controller.js";
import { TasksController } from "./runs/tasks.controller.js";
import { RunsService } from "./runs/runs.service.js";
import { BACKLOG, CHECKPOINTER, ENV, MEMORY, MODEL, ROLE_MODELS } from "./tokens.js";

@Module({
  controllers: [
    RunsController,
    ReposController,
    ProjectsController,
    RubricController,
    TasksController,
    MissionsController,
  ],
  providers: [
    { provide: ENV, useFactory: loadApiEnv },
    {
      provide: MODEL,
      useFactory: (env: ApiEnv) => getModel(env),
      inject: [ENV],
    },
    {
      provide: ROLE_MODELS,
      useFactory: (env: ApiEnv) => buildRoleModels(env),
      inject: [ENV],
    },
    {
      provide: CHECKPOINTER,
      useFactory: (env: ApiEnv) => createCheckpointer(env),
      inject: [ENV],
    },
    {
      provide: MEMORY,
      useFactory: (env: ApiEnv) => createMemory(env),
      inject: [ENV],
    },
    {
      provide: BACKLOG,
      useFactory: (env: ApiEnv) => createBacklog(env),
      inject: [ENV],
    },
    RunsService,
    ProjectsService,
    MissionsService,
    { provide: APP_GUARD, useClass: ApiKeyGuard },
  ],
})
export class AppModule {}
