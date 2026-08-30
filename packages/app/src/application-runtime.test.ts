import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MockProvider } from 'dagent-ai/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { createApplicationRuntime } from './application-runtime.js';
import { appConfigSchema } from './config.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('application runtime container', () => {
  it('owns services without starting an HTTP server', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dagent-application-runtime-'));
    temporaryDirectories.push(directory);
    const runtime = await createApplicationRuntime({
      config: appConfigSchema.parse({ dataDirectory: directory }),
      provider: new MockProvider([]),
    });

    expect(await runtime.repository.listProjects()).toEqual([]);
    expect(await runtime.repository.listAllConversations()).toEqual([]);
    expect(runtime.runner.catalog.get('tool.read_file')).toBeDefined();

    await runtime.close();
  });
});
