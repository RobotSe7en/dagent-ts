import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RunId } from 'dagent-ai';
import { MockProvider } from 'dagent-ai/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { appConfigSchema } from '../config.js';
import { AppRepository } from '../database/repositories.js';
import { createApplication } from './server.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('run recovery', () => {
  it('marks unfinished persisted runs interrupted and closes their event timeline', async () => {
    const directory = await temporaryDirectory();
    const config = appConfigSchema.parse({ dataDirectory: join(directory, 'data') });
    const runId = 'run_recovery_fixture' as RunId;
    const first = await createApplication({
      config,
      provider: new MockProvider([]),
      logger: false,
    });
    await new AppRepository(first.database).insertRun({
      id: runId,
      target: {
        kind: 'tool-agent',
        id: 'assistant',
        name: 'Assistant',
        systemPrompt: 'RECOVERY_SECRET',
        scope: {},
      },
      runInput: { prompt: 'unfinished' },
    });
    await first.close();

    const second = await createApplication({
      config,
      provider: new MockProvider([]),
      logger: false,
    });
    const run = await second.server.inject({
      method: 'GET',
      url: `/api/v1/runs/${runId}`,
    });
    const events = await second.server.inject({
      method: 'GET',
      url: `/api/v1/runs/${runId}/event-log`,
    });

    expect(run.json()).toMatchObject({
      id: runId,
      status: 'interrupted',
      target: { kind: 'tool-agent', id: 'assistant' },
    });
    expect(run.body).not.toContain('RECOVERY_SECRET');
    expect(events.json()).toEqual({
      events: [
        expect.objectContaining({
          runId,
          sequence: 1,
          type: 'run-completed',
          outcome: 'interrupted',
        }),
      ],
    });
    await second.close();
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dagent-run-recovery-'));
  temporaryDirectories.push(directory);
  return directory;
}
