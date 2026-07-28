import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineToolAgent, Runner } from 'dagent-ai';
import { MockProvider } from 'dagent-ai/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../database/database.js';
import { AppRepository } from '../database/repositories.js';
import { RunService } from './run-service.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('RunService', () => {
  it('persists durable events and separate conversation/model histories', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dagent-app-'));
    temporaryDirectories.push(directory);
    const database = await openDatabase(join(directory, 'app.sqlite3'));
    const repository = new AppRepository(database);
    const project = await repository.createProject({
      name: 'Test',
      rootPath: directory,
    });
    const conversation = await repository.createConversation({
      projectId: project.id,
      title: 'History',
    });
    const provider = new MockProvider([
      {
        content: 'Hello from Dagent.',
        reasoningContent: 'Private reasoning record.',
        refusal: '',
        toolCalls: [],
      },
      {
        content: 'Second answer.',
        reasoningContent: '',
        refusal: '',
        toolCalls: [],
      },
    ]);
    const runner = new Runner({
      provider,
      workspace: join(directory, 'runs'),
    });
    const service = new RunService(runner, repository);
    const agent = defineToolAgent({
      kind: 'tool-agent',
      id: 'assistant',
      name: 'Assistant',
      scope: { capabilities: [] },
      reviewLevel: 'never',
    });

    const runId = await service.start({
      conversationId: conversation.id,
      target: agent,
      runInput: { prompt: 'Hello' },
    });
    const stored = await waitForRun(repository, runId);
    const firstUpdate = await repository.getConversation(conversation.id);

    expect(stored.status).toBe('completed');
    expect((await repository.eventsAfter(runId, 0)).at(-1)?.type).toBe('run-completed');
    expect(stored.input).toEqual({ prompt: 'Hello' });
    expect(firstUpdate?.conversation.items).toHaveLength(2);
    expect(firstUpdate?.modelThread?.items).toHaveLength(2);
    expect(firstUpdate?.modelThread?.items.find((item) => item.type === 'assistant')).toMatchObject(
      {
        reasoning: 'Private reasoning record.',
      },
    );

    const secondRunId = await service.start({
      conversationId: conversation.id,
      target: agent,
      runInput: { prompt: 'Continue' },
    });
    await waitForRun(repository, secondRunId);
    const secondUpdate = await repository.getConversation(conversation.id);

    expect(secondUpdate?.conversation.items.map(({ type }) => type)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(secondUpdate?.modelThread?.items).toHaveLength(4);
    expect(provider.requests[1]?.messages.map(({ role, content }) => ({ role, content }))).toEqual(
      expect.arrayContaining([
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hello from Dagent.' },
        { role: 'user', content: 'Continue' },
      ]),
    );
    await runner.close();
    await database.destroy();
  });
});

async function waitForRun(
  repository: AppRepository,
  runId: Parameters<AppRepository['getRun']>[0],
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = await repository.getRun(runId);
    if (run !== undefined && run.status !== 'running') return run;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error('Run did not finish.');
}
