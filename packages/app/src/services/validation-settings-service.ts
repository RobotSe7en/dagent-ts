import type { Runner } from 'dagent-ai';
import { z } from 'zod';

import type { AppRepository } from '../database/repositories.js';

const validationEnabledSetting = 'validation.enabled';

export type ValidationSettings = {
  readonly enabled: boolean;
  readonly maxRetries: number;
  readonly profile: string | undefined;
};

export class ValidationSettingsService {
  public constructor(
    private readonly runner: Runner,
    private readonly repository: AppRepository,
  ) {}

  public async initialize(): Promise<void> {
    const persisted = await this.repository.setting(validationEnabledSetting);
    if (persisted !== undefined) {
      this.runner.setValidationEnabled(z.boolean().parse(persisted));
    }
  }

  public get(): ValidationSettings {
    return payload(this.runner);
  }

  public async setEnabled(enabled: boolean): Promise<ValidationSettings> {
    this.runner.setValidationEnabled(enabled);
    await this.repository.setSetting(validationEnabledSetting, enabled);
    return this.get();
  }
}

function payload(runner: Runner): ValidationSettings {
  return {
    enabled: runner.validationPolicy.enabled,
    maxRetries: runner.validationPolicy.maxRetries,
    profile: runner.validationPolicy.profile?.name,
  };
}
