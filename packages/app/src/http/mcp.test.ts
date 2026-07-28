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

describe('MCP server resources', () => {
  it('persists managed servers while redacting configured and managed secrets', async () => {
    const directory = await temporaryDirectory();
    const config = appConfigSchema.parse({
      dataDirectory: join(directory, 'data'),
      mcpServers: [
        {
          name: 'configured',
          transport: 'http',
          url: 'https://mcp.example.test',
          headers: { Authorization: 'Bearer configured-secret' },
          enabled: false,
        },
      ],
    });
    const first = await createApplication({
      config,
      provider: new MockProvider([]),
      logger: false,
    });
    const created = await first.server.inject({
      method: 'POST',
      url: '/api/v1/mcp/servers',
      payload: {
        name: 'managed',
        transport: 'stdio',
        command: 'managed-mcp',
        env: { MCP_TOKEN: 'managed-secret' },
        enabled: false,
      },
    });
    const updated = await first.server.inject({
      method: 'PUT',
      url: '/api/v1/mcp/servers/managed',
      payload: {
        config: {
          name: 'managed',
          transport: 'stdio',
          command: 'new-command',
          enabled: false,
        },
        secretAction: 'preserve',
      },
    });
    const updateConfigured = await first.server.inject({
      method: 'PUT',
      url: '/api/v1/mcp/servers/configured',
      payload: {
        config: {
          name: 'configured',
          transport: 'http',
          url: 'https://different.example.test',
          enabled: false,
        },
      },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      server: {
        name: 'managed',
        source: 'managed',
        status: 'disabled',
        config: {
          secretNames: ['MCP_TOKEN'],
          secretsConfigured: true,
        },
      },
    });
    expect(updated.json()).toMatchObject({
      server: {
        config: {
          command: 'new-command',
          secretNames: ['MCP_TOKEN'],
          secretsConfigured: true,
        },
      },
    });
    expect(updateConfigured.statusCode).toBe(400);
    expect(JSON.stringify(created.json())).not.toContain('managed-secret');
    await first.close();

    const second = await createApplication({
      config,
      provider: new MockProvider([]),
      logger: false,
    });
    const listed = await second.server.inject({
      method: 'GET',
      url: '/api/v1/mcp/servers',
    });
    const payload = listed.json();

    expect(payload).toMatchObject({
      servers: [
        {
          name: 'configured',
          source: 'config',
          status: 'disabled',
          config: {
            secretNames: ['Authorization'],
            secretsConfigured: true,
          },
        },
        {
          name: 'managed',
          source: 'managed',
          status: 'disabled',
          config: {
            command: 'new-command',
            secretNames: ['MCP_TOKEN'],
            secretsConfigured: true,
          },
        },
      ],
    });
    expect(JSON.stringify(payload)).not.toContain('configured-secret');
    expect(JSON.stringify(payload)).not.toContain('managed-secret');
    await second.close();
  });

  it('keeps a failed enabled server editable and reports its connection error', async () => {
    const directory = await temporaryDirectory();
    const application = await createApplication({
      config: appConfigSchema.parse({ dataDirectory: join(directory, 'data') }),
      provider: new MockProvider([]),
      logger: false,
    });
    const created = await application.server.inject({
      method: 'POST',
      url: '/api/v1/mcp/servers',
      payload: {
        name: 'unavailable',
        transport: 'stdio',
        command: `missing-mcp-command-${Date.now()}`,
        connectTimeoutMs: 1_000,
      },
    });
    const disabled = await application.server.inject({
      method: 'PUT',
      url: '/api/v1/mcp/servers/unavailable',
      payload: {
        config: {
          name: 'unavailable',
          transport: 'stdio',
          command: 'still-unavailable',
          enabled: false,
        },
      },
    });
    const deleted = await application.server.inject({
      method: 'DELETE',
      url: '/api/v1/mcp/servers/unavailable',
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      server: {
        name: 'unavailable',
        status: 'error',
        editable: true,
      },
    });
    expect(created.json<{ server: { error?: string } }>().server.error).toBeTruthy();
    expect(disabled.json()).toMatchObject({
      server: { status: 'disabled' },
    });
    expect(disabled.json<{ server: object }>().server).not.toHaveProperty('error');
    expect(deleted.statusCode).toBe(204);
    await application.close();
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dagent-mcp-'));
  temporaryDirectories.push(directory);
  return directory;
}
