import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { MODEL_PROVIDERS, type ModelProvider } from "@arzonic/agent-core";
import type { AppSettingsService } from "@arzonic/agent-shared";
import type { AppSettings } from "@arzonic/agent-client";
import type { ApiEnv } from "../env.js";
import { ENV, SETTINGS } from "../tokens.js";
import { assertProvidersConfigured } from "../role-models.util.js";
import type { UpdateRoleModelsDto } from "./settings.dto.js";

@Injectable()
export class SettingsService {
  constructor(
    @Inject(SETTINGS) private readonly settings: AppSettingsService | null,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  /** Which providers have an API key configured server-side — the UI offers only these. */
  private availableProviders(): ModelProvider[] {
    const keyFor: Record<ModelProvider, string | undefined> = {
      mistral: this.env.MISTRAL_API_KEY,
      anthropic: this.env.ANTHROPIC_API_KEY,
      // Gemini is available via EITHER an API key OR Vertex AI / ADC (a GCP project).
      google: this.env.GOOGLE_API_KEY ?? this.env.GOOGLE_CLOUD_PROJECT,
    };
    return MODEL_PROVIDERS.filter((p) => keyFor[p]);
  }

  async get(): Promise<AppSettings> {
    const roleModels = this.settings ? await this.settings.getRoleModels() : {};
    return {
      roleModels,
      envRoleModels: this.env.LLM_ROLE_MODELS ?? {},
      availableProviders: this.availableProviders(),
      persisted: this.settings !== null,
    };
  }

  async updateRoleModels(dto: UpdateRoleModelsDto): Promise<AppSettings> {
    if (!this.settings) {
      throw new BadRequestException("Settings need a database — set SUPABASE_DB_URL.");
    }
    // Same server-side guard every door into a persisted team config funnels through.
    assertProvidersConfigured(this.env, dto.roleModels);
    await this.settings.setRoleModels(dto.roleModels);
    return this.get();
  }
}
