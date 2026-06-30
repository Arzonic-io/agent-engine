import { Controller, Get, Inject } from "@nestjs/common";
import type { GitHubRepo, RepoInfo } from "@arzonic/agent-shared";
import { RunsService } from "./runs.service.js";

@Controller("repos")
export class ReposController {
  constructor(@Inject(RunsService) private readonly runs: RunsService) {}

  @Get()
  list(): Promise<RepoInfo[]> {
    return this.runs.listRepos();
  }

  /** GitHub repos the configured token can push to — for the project repo picker. */
  @Get("github")
  listGitHub(): Promise<GitHubRepo[]> {
    return this.runs.listGitHubRepos();
  }
}
