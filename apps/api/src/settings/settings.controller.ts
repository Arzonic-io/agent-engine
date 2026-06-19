import { Body, Controller, Get, Inject, Put } from "@nestjs/common";
import type { AppSettings } from "@arzonic/agent-client";
import { ZodValidationPipe } from "../runs/dto/runs.dto.js";
import { UpdateRoleModelsSchema, type UpdateRoleModelsDto } from "./settings.dto.js";
import { SettingsService } from "./settings.service.js";

@Controller("settings")
export class SettingsController {
  constructor(@Inject(SettingsService) private readonly settings: SettingsService) {}

  @Get()
  get(): Promise<AppSettings> {
    return this.settings.get();
  }

  @Put("role-models")
  updateRoleModels(
    @Body(new ZodValidationPipe(UpdateRoleModelsSchema)) dto: UpdateRoleModelsDto,
  ): Promise<AppSettings> {
    return this.settings.updateRoleModels(dto);
  }
}
