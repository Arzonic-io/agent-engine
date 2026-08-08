import { BadRequestException, Controller, Get, Inject, Query } from "@nestjs/common";
import type { GitHubIssue, GitHubRepo, RepoInfo } from "@arzonic/agent-shared";
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

  /** A repo's open issues — for the "start a mission from an issue" picker. */
  @Get("github/issues")
  listGitHubIssues(
    @Query("owner") owner: string,
    @Query("repo") repo: string,
  ): Promise<GitHubIssue[]> {
    if (!owner?.trim() || !repo?.trim()) {
      throw new BadRequestException("owner and repo query params are required");
    }
    return this.runs.listGitHubIssues(owner.trim(), repo.trim());
  }
}
