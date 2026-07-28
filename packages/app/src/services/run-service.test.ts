import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineToolAgent, Runner, tool } from 'dagent-ai';
import { MockProvider } from 'dagent-ai/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { openDatabase } from '../database/database.js';
import { AppRepository, requireConversationState } from '../database/repositories.js';
import { RunService } from './run-service.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('RunService', () => {
  it('persists one canonical V3 conversation while keeping reasoning out of replay', async () => {
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
    expect(firstUpdate).toBeDefined();
    if (firstUpdate === undefined) return;
    const firstConversation = requireConversationState(firstUpdate);
    expect(firstConversation.items).toHaveLength(2);
    expect(firstConversation.items.find((item) => item.type === 'assistant')).toMatchObject({
      reasoning: 'Private reasoning record.',
    });

    const secondRunId = await service.start({
      conversationId: conversation.id,
      target: agent,
      runInput: { prompt: 'Continue' },
    });
    await waitForRun(repository, secondRunId);
    const secondUpdate = await repository.getConversation(conversation.id);

    expect(secondUpdate).toBeDefined();
    if (secondUpdate === undefined) return;
    const secondConversation = requireConversationState(secondUpdate);
    expect(secondConversation.items.map(({ type }) => type)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(secondConversation.items).toHaveLength(4);
    expect(provider.requests[1]?.messages.map(({ role, content }) => ({ role, content }))).toEqual(
      expect.arrayContaining([
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hello from Dagent.' },
        { role: 'user', content: 'Continue' },
      ]),
    );
    expect(JSON.stringify(provider.requests[1]?.messages)).not.toContain(
      'Private reasoning record.',
    );
    await runner.close();
    await database.destroy();
  });

  it('atomically claims a review checkpoint so concurrent approvals execute once', async () => {
    const directory = await temporaryDirectory();
    const database = await openDatabase(join(directory, 'app.sqlite3'));
    const repository = new AppRepository(database);
    const project = await repository.createProject({ name: 'Review', rootPath: directory });
    const conversation = await repository.createConversation({
      projectId: project.id,
      title: 'Atomic review',
    });
    let invocations = 0;
    const risky = tool({
      id: 'tool.atomic-review',
      input: z.object({}).strict(),
      output: z.literal('approved'),
      risk: 'high',
      execute: () => {
        invocations += 1;
        return 'approved' as const;
      },
    });
    const provider = new MockProvider([
      {
        content: '',
        reasoningContent: '',
        refusal: '',
        toolCalls: [{ id: 'call-atomic', name: 'tool.atomic-review', arguments: {} }],
      },
      {
        content: 'complete',
        reasoningContent: '',
        refusal: '',
        toolCalls: [],
      },
    ]);
    const runner = new Runner({
      provider,
      capabilities: [risky],
      workspace: join(directory, 'runs'),
    });
    const service = new RunService(runner, repository);
    const agent = defineToolAgent({
      kind: 'tool-agent',
      id: 'review-agent',
      name: 'Review agent',
      scope: { capabilities: ['tool.atomic-review'] },
      reviewLevel: 'risky',
    });
    const runId = await service.start({
      conversationId: conversation.id,
      target: agent,
      runInput: { prompt: 'approve once' },
    });
    const pending = await waitForRunStatus(repository, runId, 'awaiting-review');
    const review = pending.checkpoint?.state.pendingReview;
    expect(review).toBeDefined();
    if (review === undefined) return;
    const decision = {
      reviewId: review.id,
      revision: review.revision,
      action: 'approve' as const,
      reason: '',
    };

    const attempts = await Promise.allSettled([
      service.resume(runId, decision),
      service.resume(runId, decision),
    ]);
    await waitForRunStatus(repository, runId, 'completed');

    expect(attempts.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    expect(invocations).toBe(1);
    await service.close();
    await database.destroy();
  });

  it('rejects review execution when the persisted conversation revision is stale', async () => {
    const directory = await temporaryDirectory();
    const database = await openDatabase(join(directory, 'app.sqlite3'));
    const repository = new AppRepository(database);
    const project = await repository.createProject({ name: 'Review', rootPath: directory });
    const conversation = await repository.createConversation({
      projectId: project.id,
      title: 'Stale review',
    });
    let invocations = 0;
    const risky = tool({
      id: 'tool.stale-review',
      input: z.object({}).strict(),
      output: z.literal('approved'),
      risk: 'high',
      execute: () => {
        invocations += 1;
        return 'approved' as const;
      },
    });
    const provider = new MockProvider([
      {
        content: '',
        reasoningContent: '',
        refusal: '',
        toolCalls: [{ id: 'call-stale', name: 'tool.stale-review', arguments: {} }],
      },
    ]);
    const runner = new Runner({
      provider,
      capabilities: [risky],
      workspace: join(directory, 'runs'),
    });
    const service = new RunService(runner, repository);
    const agent = defineToolAgent({
      kind: 'tool-agent',
      id: 'stale-review-agent',
      name: 'Stale review agent',
      scope: { capabilities: ['tool.stale-review'] },
      reviewLevel: 'risky',
    });
    const runId = await service.start({
      conversationId: conversation.id,
      target: agent,
      runInput: { prompt: 'do not replay stale state' },
    });
    const pending = await waitForRunStatus(repository, runId, 'awaiting-review');
    const review = pending.checkpoint?.state.pendingReview;
    expect(review).toBeDefined();
    if (review === undefined) return;
    await database
      .updateTable('conversations')
      .set({ revision: conversation.revision + 100 })
      .where('id', '=', conversation.id)
      .execute();

    await expect(
      service.resume(runId, {
        reviewId: review.id,
        revision: review.revision,
        action: 'approve',
        reason: '',
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVIEW' });
    expect(invocations).toBe(0);
    await service.close();
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

async function waitForRunStatus(
  repository: AppRepository,
  runId: Parameters<AppRepository['getRun']>[0],
  status: string,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = await repository.getRun(runId);
    if (run?.status === status) return run;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(`Run did not reach status '${status}'.`);
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dagent-app-'));
  temporaryDirectories.push(directory);
  return directory;
}
