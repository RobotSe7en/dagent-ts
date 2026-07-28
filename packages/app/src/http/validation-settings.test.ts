import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MockProvider } from 'dagent-ai/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { appConfigSchema } from '../config.js';
import { createApplication } from './server.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('validation settings', () => {
  it('persists an explicit validation override across application restarts', async () => {
    const directory = await temporaryDirectory();
    const config = appConfigSchema.parse({
      dataDirectory: join(directory, 'data'),
      validation: { enabled: false, maxRetries: 2 },
    });
    const first = await createApplication({
      config,
      provider: new MockProvider([]),
      logger: false,
    });
    const initial = await first.server.inject({
      method: 'GET',
      url: '/api/v1/settings/validation',
    });
    const enabled = await first.server.inject({
      method: 'PUT',
      url: '/api/v1/settings/validation',
      payload: { enabled: true },
    });

    expect(initial.json()).toEqual({
      enabled: false,
      maxRetries: 2,
      profile: 'validator_agent',
    });
    expect(enabled.json()).toEqual({
      enabled: true,
      maxRetries: 2,
      profile: 'validator_agent',
    });
    expect(first.runner.validationPolicy.enabled).toBe(true);
    await first.close();

    const second = await createApplication({
      config,
      provider: new MockProvider([]),
      logger: false,
    });
    const restored = await second.server.inject({
      method: 'GET',
      url: '/api/v1/settings/validation',
    });
    const invalid = await second.server.inject({
      method: 'PUT',
      url: '/api/v1/settings/validation',
      payload: { enabled: 'yes' },
    });

    expect(restored.json()).toMatchObject({ enabled: true, maxRetries: 2 });
    expect(second.runner.validationPolicy.enabled).toBe(true);
    expect(invalid.statusCode).toBe(400);
    await second.close();
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dagent-validation-settings-'));
  temporaryDirectories.push(directory);
  return directory;
}
