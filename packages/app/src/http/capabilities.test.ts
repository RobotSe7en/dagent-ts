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

describe('capability resources', () => {
  it('persists template capabilities and enabled overrides with agent reference protection', async () => {
    const directory = await temporaryDirectory();
    const config = appConfigSchema.parse({ dataDirectory: join(directory, 'data') });
    const first = await createApplication({
      config,
      provider: new MockProvider([]),
      logger: false,
    });
    const created = await first.server.inject({
      method: 'POST',
      url: '/api/v1/capabilities/templates',
      payload: {
        id: 'tool.greeting',
        name: 'Greeting',
        description: 'Formats a greeting.',
        template: 'Hello {person.name}! {{literal}}',
        inputSchema: {
          type: 'object',
          properties: {
            person: {
              type: 'object',
              properties: { name: { type: 'string' } },
              required: ['name'],
              additionalProperties: false,
            },
          },
          required: ['person'],
          additionalProperties: false,
        },
      },
    });
    const tested = await first.server.inject({
      method: 'POST',
      url: '/api/v1/capabilities/tool.greeting/test',
      payload: { arguments: { person: { name: 'Ada' } } },
    });
    await first.server.inject({
      method: 'POST',
      url: '/api/v1/agents',
      payload: {
        kind: 'tool-agent',
        id: 'greeter',
        name: 'Greeter',
        scope: { capabilities: ['tool.greeting'] },
        reviewLevel: 'never',
      },
    });
    const disableInUse = await first.server.inject({
      method: 'PATCH',
      url: '/api/v1/capabilities/tool.greeting',
      payload: { enabled: false },
    });
    await first.server.inject({
      method: 'DELETE',
      url: '/api/v1/agents/greeter',
    });
    const disabled = await first.server.inject({
      method: 'PATCH',
      url: '/api/v1/capabilities/tool.greeting',
      payload: { enabled: false },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      capability: {
        definition: { id: 'tool.greeting', enabled: true, source: 'managed:template' },
      },
    });
    expect(tested.json()).toMatchObject({
      result: { status: 'completed', output: 'Hello Ada! {literal}' },
    });
    expect(disableInUse.statusCode).toBe(409);
    expect(disabled.json()).toMatchObject({
      capability: { id: 'tool.greeting', enabled: false },
    });
    await first.close();

    const second = await createApplication({
      config,
      provider: new MockProvider([]),
      logger: false,
    });
    const listed = await second.server.inject({
      method: 'GET',
      url: '/api/v1/capabilities?kind=tool',
    });
    const testDisabled = await second.server.inject({
      method: 'POST',
      url: '/api/v1/capabilities/tool.greeting/test',
      payload: { arguments: { person: { name: 'Grace' } } },
    });
    const updated = await second.server.inject({
      method: 'PUT',
      url: '/api/v1/capabilities/templates/tool.greeting',
      payload: {
        id: 'tool.greeting',
        name: 'Greeting v2',
        template: 'Welcome {person.name}',
        inputSchema: {
          type: 'object',
          properties: {
            person: {
              type: 'object',
              properties: { name: { type: 'string' } },
              required: ['name'],
            },
          },
          required: ['person'],
        },
      },
    });
    const enabled = await second.server.inject({
      method: 'PATCH',
      url: '/api/v1/capabilities/tool.greeting',
      payload: { enabled: true },
    });
    const testedV2 = await second.server.inject({
      method: 'POST',
      url: '/api/v1/capabilities/tool.greeting/test',
      payload: { arguments: { person: { name: 'Grace' } } },
    });
    const deleted = await second.server.inject({
      method: 'DELETE',
      url: '/api/v1/capabilities/templates/tool.greeting',
    });

    expect(
      listed
        .json<{ capabilities: { id: string; enabled: boolean }[] }>()
        .capabilities.find(({ id }) => id === 'tool.greeting'),
    ).toMatchObject({ id: 'tool.greeting', enabled: false });
    expect(testDisabled.statusCode).toBe(404);
    expect(updated.json()).toMatchObject({
      capability: {
        config: { name: 'Greeting v2' },
        definition: { enabled: false },
      },
    });
    expect(enabled.json()).toMatchObject({
      capability: { enabled: true },
    });
    expect(testedV2.json()).toMatchObject({
      result: { status: 'completed', output: 'Welcome Grace' },
    });
    expect(deleted.statusCode).toBe(204);
    await second.close();
  });

  it('validates template input schemas before invoking user logic', async () => {
    const directory = await temporaryDirectory();
    const application = await createApplication({
      config: appConfigSchema.parse({ dataDirectory: join(directory, 'data') }),
      provider: new MockProvider([]),
      logger: false,
    });
    await application.server.inject({
      method: 'POST',
      url: '/api/v1/capabilities/templates',
      payload: {
        id: 'tool.typed',
        name: 'Typed',
        template: '{count}',
        inputSchema: {
          type: 'object',
          properties: { count: { type: 'integer' } },
          required: ['count'],
          additionalProperties: false,
        },
      },
    });
    const invalid = await application.server.inject({
      method: 'POST',
      url: '/api/v1/capabilities/tool.typed/test',
      payload: { arguments: { count: 'not-a-number' } },
    });

    expect(invalid.statusCode).toBe(400);
    await application.close();
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dagent-capabilities-'));
  temporaryDirectories.push(directory);
  return directory;
}
