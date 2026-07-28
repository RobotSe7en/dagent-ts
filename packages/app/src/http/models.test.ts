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

describe('model provider resources', () => {
  it('redacts credentials and enforces active/configured provider lifecycle rules', async () => {
    const directory = await temporaryDirectory();
    const application = await createApplication({
      config: appConfigSchema.parse({
        dataDirectory: join(directory, 'data'),
        provider: {
          baseURL: 'https://configured.example/v1',
          model: 'configured-model',
          apiKey: 'configured-secret',
        },
      }),
      provider: new MockProvider([]),
      logger: false,
    });
    const initial = await application.server.inject({ method: 'GET', url: '/api/v1/models' });
    const created = await application.server.inject({
      method: 'POST',
      url: '/api/v1/models',
      payload: {
        id: 'secondary',
        name: 'Secondary',
        baseURL: 'https://secondary.example/v1',
        model: 'secondary-model',
        apiKey: 'managed-secret',
        apiKeyAction: 'replace',
      },
    });
    const updated = await application.server.inject({
      method: 'PUT',
      url: '/api/v1/models/secondary',
      payload: {
        id: 'secondary',
        name: 'Updated secondary',
        baseURL: 'https://secondary.example/v1',
        model: 'secondary-model-v2',
        apiKeyAction: 'preserve',
      },
    });
    const activated = await application.server.inject({
      method: 'POST',
      url: '/api/v1/models/secondary/activate',
    });
    const deleteActive = await application.server.inject({
      method: 'DELETE',
      url: '/api/v1/models/secondary',
    });
    const updateConfigured = await application.server.inject({
      method: 'PUT',
      url: '/api/v1/models/configured',
      payload: {
        id: 'configured',
        name: 'Invalid',
        baseURL: 'https://invalid.example/v1',
        model: 'invalid',
      },
    });

    expect(initial.json()).toMatchObject({
      activeModelId: 'configured',
      models: [
        expect.objectContaining({
          id: 'configured',
          source: 'config',
          editable: false,
          apiKeyConfigured: true,
          apiKeySaved: true,
        }),
      ],
    });
    expect(JSON.stringify(initial.json())).not.toContain('configured-secret');
    expect(created.json()).toMatchObject({
      model: {
        id: 'secondary',
        apiKeySaved: true,
        apiKeyConfigured: true,
      },
    });
    expect(JSON.stringify(created.json())).not.toContain('managed-secret');
    expect(updated.json()).toMatchObject({
      model: { name: 'Updated secondary', model: 'secondary-model-v2', apiKeySaved: true },
    });
    expect(activated.json()).toMatchObject({ activeModelId: 'secondary' });
    expect(deleteActive.statusCode).toBe(409);
    expect(updateConfigured.statusCode).toBe(400);
    await application.close();
  });

  it('restores the active managed provider and permits deletion after switching away', async () => {
    const directory = await temporaryDirectory();
    const config = appConfigSchema.parse({ dataDirectory: join(directory, 'data') });
    const first = await createApplication({
      config,
      provider: new MockProvider([]),
      logger: false,
    });
    await first.server.inject({
      method: 'POST',
      url: '/api/v1/models',
      payload: {
        id: 'persistent',
        name: 'Persistent',
        baseURL: 'https://persistent.example/v1',
        model: 'persistent-model',
        apiKeyEnv: 'PERSISTENT_MODEL_KEY',
      },
    });
    await first.server.inject({
      method: 'POST',
      url: '/api/v1/models/persistent/activate',
    });
    await first.close();

    const second = await createApplication({
      config,
      provider: new MockProvider([]),
      logger: false,
    });
    const restored = await second.server.inject({ method: 'GET', url: '/api/v1/models' });
    const switched = await second.server.inject({
      method: 'POST',
      url: '/api/v1/models/configured/activate',
    });
    const deleted = await second.server.inject({
      method: 'DELETE',
      url: '/api/v1/models/persistent',
    });

    expect(restored.json()).toMatchObject({ activeModelId: 'persistent' });
    expect(switched.json()).toMatchObject({ activeModelId: 'configured' });
    expect(deleted.statusCode).toBe(204);
    await second.close();
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dagent-models-'));
  temporaryDirectories.push(directory);
  return directory;
}
