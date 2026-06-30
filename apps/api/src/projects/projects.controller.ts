import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import { z } from "zod";
import { RoleModelsConfigSchema } from "@arzonic/agent-core";
import type { Project, ProjectWithStats, Task } from "@arzonic/agent-shared";
import type { StartRunResponse } from "@arzonic/agent-client";
import type { ApiEnv } from "../env.js";
import { ENV } from "../tokens.js";
import { assertProvidersConfigured } from "../role-models.util.js";
import { ZodValidationPipe } from "../runs/dto/runs.dto.js";
import { RunsService } from "../runs/runs.service.js";
import { ProjectsService } from "./projects.service.js";

/**
 * Bind a GitHub repo instead of a raw path (the "pick a repo, not a path" flow):
 * the backend clones it to a managed workspace and uses that as repoPath. Takes
 * precedence over `repoPath` when both are sent.
 */
const GitHubRepoBindSchema = z.object({
  owner: z.string().min(1).max(120),
  repo: z.string().min(1).max(140),
});

const CreateProjectSchema = z.object({
  name: z.string().min(1).max(200),
  brief: z.string().max(20_000).optional().default(""),
  repoPath: z.string().min(1).optional(),
  githubRepo: GitHubRepoBindSchema.optional(),
  /** The project's default team — new missions inherit it for roles they don't pin. */
  roleModels: RoleModelsConfigSchema.optional(),
});
type CreateProjectDto = z.infer<typeof CreateProjectSchema>;

// Edit name/brief and/or the bound repo. `repoPath: null` clears the repo.
const UpdateProjectSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  brief: z.string().max(20_000).optional(),
  repoPath: z.string().min(1).nullable().optional(),
  githubRepo: GitHubRepoBindSchema.optional(),
  /** The project's default team config; new missions inherit it. */
  roleModels: RoleModelsConfigSchema.optional(),
});
type UpdateProjectDto = z.infer<typeof UpdateProjectSchema>;

const StartTaskSchema = z.object({
  task: z.string().min(1).max(20_000),
  repoPath: z.string().min(1).optional(),
});
type StartTaskDto = z.infer<typeof StartTaskSchema>;

@Controller("projects")
export class ProjectsController {
  constructor(
    @Inject(ProjectsService) private readonly projects: ProjectsService,
    @Inject(RunsService) private readonly runs: RunsService,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  @Post(":id/tasks")
  startTask(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(StartTaskSchema)) dto: StartTaskDto,
  ): Promise<StartRunResponse> {
    return this.runs.startProjectTask(id, dto.task, dto.repoPath);
  }

  @Post()
  async create(
    @Body(new ZodValidationPipe(CreateProjectSchema)) dto: CreateProjectDto,
  ): Promise<Project> {
    const settings: Record<string, unknown> = {};
    if (dto.githubRepo) {
      // Clone the GitHub repo to a managed workspace and bind that path.
      const ws = await this.runs.ensureGitHubWorkspace(dto.githubRepo.owner, dto.githubRepo.repo);
      settings.repoPath = ws.path;
      settings.githubRepo = { ...dto.githubRepo, defaultBranch: ws.defaultBranch };
    } else if (dto.repoPath) {
      settings.repoPath = this.runs.validateRepoPath(dto.repoPath);
    }
    if (dto.roleModels) {
      assertProvidersConfigured(this.env, dto.roleModels);
      settings.roleModels = dto.roleModels;
    }
    return this.projects.create(dto.name, dto.brief, settings);
  }

  @Patch(":id")
  async update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateProjectSchema)) dto: UpdateProjectDto,
  ): Promise<Project> {
    let updated: Project | null = null;

    if (dto.name !== undefined || dto.brief !== undefined) {
      updated = await this.projects.update(id, { name: dto.name, brief: dto.brief });
    }

    if (dto.githubRepo) {
      // Re-bind to a GitHub repo: clone/refresh the workspace and store both the
      // path and the repo identity (so the UI shows owner/repo, not a path).
      const ws = await this.runs.ensureGitHubWorkspace(dto.githubRepo.owner, dto.githubRepo.repo);
      updated = await this.projects.updateSettings(id, {
        repoPath: ws.path,
        githubRepo: { ...dto.githubRepo, defaultBranch: ws.defaultBranch },
      });
    } else if (dto.repoPath !== undefined) {
      // Setting a raw path (or clearing) drops any prior GitHub identity.
      const repoPath = dto.repoPath ? this.runs.validateRepoPath(dto.repoPath) : null;
      updated = await this.projects.updateSettings(id, { repoPath, githubRepo: null });
    }

    if (dto.roleModels !== undefined) {
      assertProvidersConfigured(this.env, dto.roleModels);
      updated = await this.projects.updateSettings(id, { roleModels: dto.roleModels });
    }

    if (updated === null) {
      // Nothing to change, or the project doesn't exist — distinguish.
      updated = await this.projects.get(id);
    }
    if (!updated) throw new NotFoundException(`No project ${id}`);
    return updated;
  }

  @Get()
  list(): Promise<ProjectWithStats[]> {
    return this.projects.list();
  }

  @Get(":id")
  async get(@Param("id") id: string): Promise<Project> {
    const p = await this.projects.get(id);
    if (!p) throw new NotFoundException(`No project ${id}`);
    return p;
  }

  @Get(":id/tasks")
  listTasks(@Param("id") id: string): Promise<Task[]> {
    return this.projects.listTasks(id);
  }

  @Delete(":id")
  async remove(@Param("id") id: string): Promise<{ ok: true }> {
    await this.projects.delete(id);
    return { ok: true };
  }
}
