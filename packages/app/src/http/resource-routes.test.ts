import { mkdtemp, rm } from 'node:fs/promises';
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

describe('project resources', () => {
  it('creates, updates, lists, and deletes a camel-cased project resource', async () => {
    const { application, directory } = await testApplication();
    const created = await application.server.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: {
        name: 'Research',
        description: 'Initial description',
        rootPath: join(directory, 'research'),
      },
    });
    const project = created.json<{ id: string; rootPath: string }>();
    const updated = await application.server.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${project.id}`,
      payload: { name: 'Updated research', description: null },
    });
    const invalidUpdate = await application.server.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${project.id}`,
      payload: {},
    });
    const listed = await application.server.inject({
      method: 'GET',
      url: '/api/v1/projects',
    });
    const deleted = await application.server.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${project.id}`,
    });
    const missing = await application.server.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.id}`,
    });

    expect(created.statusCode).toBe(201);
    expect(project.rootPath).toBe(join(directory, 'research'));
    expect(created.json()).not.toHaveProperty('root_path');
    expect(updated.json()).toMatchObject({ id: project.id, name: 'Updated research' });
    expect(updated.json()).not.toHaveProperty('description');
    expect(invalidUpdate.statusCode).toBe(400);
    expect(listed.json()).toEqual([expect.objectContaining({ id: project.id })]);
    expect(deleted.statusCode).toBe(204);
    expect(missing.statusCode).toBe(404);
    await application.close();
  });
});

describe('conversation resources', () => {
  it('enforces project ownership across scoped conversation routes', async () => {
    const { application, directory } = await testApplication();
    const firstProject = await createProject(application, 'First', join(directory, 'first'));
    const secondProject = await createProject(application, 'Second', join(directory, 'second'));
    const created = await application.server.inject({
      method: 'POST',
      url: `/api/v1/projects/${firstProject}/conversations`,
      payload: { title: 'Planning', kind: 'dynamic-dag' },
    });
    const conversation = created.json<{ id: string }>();
    const scoped = await application.server.inject({
      method: 'GET',
      url: `/api/v1/projects/${firstProject}/conversations/${conversation.id}`,
    });
    const wrongProject = await application.server.inject({
      method: 'GET',
      url: `/api/v1/projects/${secondProject}/conversations/${conversation.id}`,
    });
    const updated = await application.server.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${firstProject}/conversations/${conversation.id}`,
      payload: { title: 'Updated plan' },
    });
    const messages = await application.server.inject({
      method: 'GET',
      url: `/api/v1/projects/${firstProject}/conversations/${conversation.id}/messages`,
    });
    const missingProject = await application.server.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      payload: { projectId: 'project_missing', title: 'Invalid' },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      projectId: firstProject,
      title: 'Planning',
      kind: 'dynamic-dag',
    });
    expect(scoped.statusCode).toBe(200);
    expect(wrongProject.statusCode).toBe(404);
    expect(updated.json()).toMatchObject({ title: 'Updated plan' });
    expect(messages.json()).toEqual({ messages: [] });
    expect(missingProject.statusCode).toBe(404);
    await application.close();
  });
});

describe('run resources', () => {
  it('persists public messages and exposes filtered runs and durable event logs', async () => {
    const { application, directory } = await testApplication(
      new MockProvider([
        {
          content: 'The persisted answer.',
          reasoningContent: 'Private chain.',
          refusal: '',
          toolCalls: [],
        },
      ]),
    );
    const projectId = await createProject(application, 'Runs', join(directory, 'runs-project'));
    const conversationResponse = await application.server.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      payload: { projectId, title: 'Run history' },
    });
    const conversationId = conversationResponse.json<{ id: string }>().id;
    const started = await application.server.inject({
      method: 'POST',
      url: '/api/v1/runs',
      payload: {
        conversationId,
        target: {
          kind: 'tool-agent',
          id: 'assistant',
          name: 'Assistant',
          systemPrompt: 'SYSTEM_PROMPT_SECRET',
          scope: { capabilities: [] },
          reviewLevel: 'never',
        },
        input: { prompt: 'Persist this.' },
      },
    });
    const runId = started.json<{ runId: string }>().runId;
    await waitForCompletedRun(application, runId);

    const eventLog = await application.server.inject({
      method: 'GET',
      url: `/api/v1/runs/${runId}/event-log?after=0`,
    });
    const messages = await application.server.inject({
      method: 'GET',
      url: `/api/v1/conversations/${conversationId}/messages`,
    });
    const conversationDetail = await application.server.inject({
      method: 'GET',
      url: `/api/v1/conversations/${conversationId}`,
    });
    const conversationList = await application.server.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/conversations`,
    });
    const scopedRuns = await application.server.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/conversations/${conversationId}/runs`,
    });
    const filteredRuns = await application.server.inject({
      method: 'GET',
      url: `/api/v1/runs?projectId=${projectId}&conversationId=${conversationId}`,
    });
    const runDetail = await application.server.inject({
      method: 'GET',
      url: `/api/v1/runs/${runId}`,
    });
    const trace = await application.server.inject({
      method: 'GET',
      url: `/api/v1/runs/${runId}/trace`,
    });
    const deleted = await application.server.inject({
      method: 'DELETE',
      url: `/api/v1/runs/${runId}`,
    });

    const eventTypes = eventLog
      .json<{ events: { type: string }[] }>()
      .events.map(({ type }) => type);
    const publicMessages = messages.json<{
      messages: { type: string; content: string; reasoning?: string }[];
    }>().messages;
    expect(started.statusCode).toBe(202);
    expect(eventTypes).toContain('run-started');
    expect(eventTypes.at(-1)).toBe('run-completed');
    expect(publicMessages.map(({ type, content }) => ({ type, content }))).toEqual([
      { type: 'user', content: 'Persist this.' },
      { type: 'assistant', content: 'The persisted answer.' },
    ]);
    expect(JSON.stringify(publicMessages)).not.toContain('Private chain.');
    const listedConversations = conversationList.json<Record<string, unknown>[]>();
    expect(listedConversations).toEqual([
      expect.objectContaining({ id: conversationId, title: 'Run history' }),
    ]);
    expect(listedConversations[0]).not.toHaveProperty('conversation');
    for (const response of [eventLog, runDetail, trace, conversationDetail]) {
      expect(response.body).not.toContain('Private chain.');
      expect(response.body).not.toContain('SYSTEM_PROMPT_SECRET');
      expect(response.body).not.toContain('EXTRA_SYSTEM_PROMPT_SECRET');
      expect(response.body).not.toContain('modelThread');
    }
    expect(trace.json()).toMatchObject({
      trace: {
        runId,
        status: 'completed',
        summary: { modelCalls: 1 },
        state: { output: 'The persisted answer.' },
      },
    });
    expect(scopedRuns.json()).toMatchObject({
      runs: [expect.objectContaining({ id: runId })],
    });
    expect(filteredRuns.json()).toMatchObject({
      runs: [expect.objectContaining({ id: runId })],
    });
    expect(deleted.statusCode).toBe(204);
    await application.close();
  });
});

async function testApplication(provider = new MockProvider([])) {
  const directory = await mkdtemp(join(tmpdir(), 'dagent-resources-'));
  temporaryDirectories.push(directory);
  const application = await createApplication({
    config: appConfigSchema.parse({
      dataDirectory: join(directory, 'data'),
      extraSystemPrompt: 'EXTRA_SYSTEM_PROMPT_SECRET',
    }),
    provider,
    logger: false,
  });
  return { application, directory };
}

async function createProject(
  application: Application,
  name: string,
  rootPath: string,
): Promise<string> {
  const response = await application.server.inject({
    method: 'POST',
    url: '/api/v1/projects',
    payload: { name, rootPath },
  });
  return response.json<{ id: string }>().id;
}

async function waitForCompletedRun(application: Application, runId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await application.server.inject({
      method: 'GET',
      url: `/api/v1/runs/${runId}`,
    });
    if (response.json<{ status: string }>().status !== 'running') return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(`Run '${runId}' did not complete.`);
}
