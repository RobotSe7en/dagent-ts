import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MockProvider } from 'dagent-ai/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { appConfigSchema } from '../config.js';
import type { Application } from './server.js';
import { createApplication } from './server.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('capability module resources', () => {
  it('uploads, invokes, protects, reloads, and persists managed TypeScript-style modules', async () => {
    const directory = await temporaryDirectory();
    const config = appConfigSchema.parse({ dataDirectory: join(directory, 'data') });
    const first = await createApplication({
      config,
      provider: new MockProvider([]),
      logger: false,
    });
    const discovered = await first.server.inject({
      method: 'POST',
      url: '/api/v1/capability-modules/discover',
      payload: {
        source: 'content',
        extension: '.mjs',
        content: moduleSource('v1'),
      },
    });
    const uploaded = await first.server.inject({
      method: 'POST',
      url: '/api/v1/capability-modules/upload',
      payload: {
        id: 'echo_module',
        filename: 'echo.mjs',
        content: moduleSource('v1'),
        exports: ['tools'],
      },
    });
    const invokedV1 = await invoke(first, 'hello');
    const source = await first.server.inject({
      method: 'GET',
      url: '/api/v1/capability-modules/echo_module/source',
    });
    const agent = await first.server.inject({
      method: 'POST',
      url: '/api/v1/agents',
      payload: {
        kind: 'tool-agent',
        id: 'module_user',
        name: 'Module user',
        scope: { capabilities: ['tool.managed_echo'] },
        reviewLevel: 'never',
      },
    });
    const deleteInUse = await first.server.inject({
      method: 'DELETE',
      url: '/api/v1/capability-modules/echo_module',
    });
    await first.server.inject({
      method: 'DELETE',
      url: '/api/v1/agents/module_user',
    });
    const replaced = await first.server.inject({
      method: 'PUT',
      url: '/api/v1/capability-modules/echo_module/source',
      payload: { content: moduleSource('v2') },
    });
    const invokedV2 = await invoke(first, 'hello');

    expect(discovered.json()).toEqual({
      exports: [{ name: 'tools', capabilityIds: ['tool.managed_echo'] }],
    });
    expect(uploaded.statusCode).toBe(201);
    expect(uploaded.json()).toMatchObject({
      module: {
        id: 'echo_module',
        source: 'managed',
        status: 'active',
        capabilities: [{ id: 'tool.managed_echo' }],
      },
    });
    expect(invokedV1).toMatchObject({ status: 'completed', output: 'v1:hello' });
    expect(source.json<{ content: string }>().content).toContain("'v1:'");
    expect(agent.statusCode).toBe(201);
    expect(deleteInUse.statusCode).toBe(409);
    expect(replaced.json()).toMatchObject({
      module: { status: 'active', capabilities: [{ id: 'tool.managed_echo' }] },
    });
    expect(invokedV2).toMatchObject({ status: 'completed', output: 'v2:hello' });
    await first.close();

    const second = await createApplication({
      config,
      provider: new MockProvider([]),
      logger: false,
    });
    const listed = await second.server.inject({
      method: 'GET',
      url: '/api/v1/capability-modules',
    });
    const invokedAfterRestart = await invoke(second, 'again');
    const deleted = await second.server.inject({
      method: 'DELETE',
      url: '/api/v1/capability-modules/echo_module',
    });

    expect(listed.json()).toMatchObject({
      modules: [{ id: 'echo_module', status: 'active' }],
    });
    expect(invokedAfterRestart).toMatchObject({ status: 'completed', output: 'v2:again' });
    expect(deleted.statusCode).toBe(204);
    await expect(
      access(join(directory, 'data', 'capability-modules', 'echo_module.mjs')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await second.close();
  });

  it('rolls back an invalid managed upload without reserving its id or file', async () => {
    const directory = await temporaryDirectory();
    const application = await createApplication({
      config: appConfigSchema.parse({ dataDirectory: join(directory, 'data') }),
      provider: new MockProvider([]),
      logger: false,
    });
    const invalid = await application.server.inject({
      method: 'POST',
      url: '/api/v1/capability-modules/upload',
      payload: {
        id: 'invalid_module',
        filename: 'invalid.mjs',
        content: 'export const tools = 42;',
        exports: ['tools'],
      },
    });
    const listed = await application.server.inject({
      method: 'GET',
      url: '/api/v1/capability-modules',
    });

    expect(invalid.statusCode).toBe(400);
    expect(listed.json()).toEqual({ modules: [] });
    await expect(
      access(join(directory, 'data', 'capability-modules', 'invalid_module.mjs')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await application.close();
  });
});

function moduleSource(version: string): string {
  return [
    'export const tools = {',
    '  schemaVersion: 1,',
    '  capabilities: [{',
    "    id: 'tool.managed_echo',",
    "    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },",
    "    outputSchema: { type: 'string' },",
    `    execute({ text }) { return '${version}:' + text; },`,
    '  }],',
    '};',
  ].join('\n');
}

async function invoke(application: Application, text: string) {
  return (
    await application.runner.catalog.invoke(
      'tool.managed_echo',
      { text },
      {
        runId: 'run_module_test' as never,
        workspacePath: '.',
        signal: new AbortController().signal,
        metadata: {},
      },
    )
  ).result;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dagent-capability-module-'));
  temporaryDirectories.push(directory);
  return directory;
}
