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

describe('agent presets', () => {
  it('validates scopes and persists managed agents across application restarts', async () => {
    const directory = await temporaryDirectory();
    const config = appConfigSchema.parse({ dataDirectory: join(directory, 'data') });
    const first = await createApplication({
      config,
      provider: new MockProvider([]),
      logger: false,
    });
    const created = await first.server.inject({
      method: 'POST',
      url: '/api/v1/agents',
      payload: toolAgent('researcher', ['tool.read_file']),
    });
    const duplicate = await first.server.inject({
      method: 'POST',
      url: '/api/v1/agents',
      payload: toolAgent('researcher', ['tool.read_file']),
    });
    const invalidScope = await first.server.inject({
      method: 'POST',
      url: '/api/v1/agents',
      payload: toolAgent('invalid', ['tool.does_not_exist']),
    });
    await first.close();

    const second = await createApplication({
      config,
      provider: new MockProvider([]),
      logger: false,
    });
    const listed = await second.server.inject({ method: 'GET', url: '/api/v1/agents' });
    const updated = await second.server.inject({
      method: 'PUT',
      url: '/api/v1/agents/researcher',
      payload: { ...toolAgent('researcher', ['tool.read_file']), name: 'Senior researcher' },
    });

    expect(created.statusCode).toBe(201);
    expect(duplicate.statusCode).toBe(409);
    expect(invalidScope.statusCode).toBe(400);
    expect(listed.json()).toEqual([
      expect.objectContaining({
        config: expect.objectContaining({ id: 'researcher', kind: 'tool-agent' }),
      }),
    ]);
    expect(second.runner.agent('researcher')).toMatchObject({ name: 'Senior researcher' });
    expect(updated.json()).toMatchObject({
      config: { id: 'researcher', name: 'Senior researcher' },
    });
    await second.close();
  });

  it('executes a registered agent from a static DAG node', async () => {
    const directory = await temporaryDirectory();
    const application = await createApplication({
      config: appConfigSchema.parse({ dataDirectory: join(directory, 'data') }),
      provider: new MockProvider([
        {
          content: 'Nested agent result.',
          reasoningContent: '',
          refusal: '',
          toolCalls: [],
        },
      ]),
      logger: false,
    });
    await application.server.inject({
      method: 'POST',
      url: '/api/v1/agents',
      payload: toolAgent('writer', []),
    });
    const started = await application.server.inject({
      method: 'POST',
      url: '/api/v1/runs',
      payload: {
        target: {
          kind: 'static-dag',
          graph: {
            schemaVersion: 1,
            id: 'agent_graph',
            name: 'Agent graph',
            nodes: [
              {
                id: 'writer',
                kind: 'agent',
                agentId: 'writer',
                prompt: 'Write the result.',
                artifactInputs: [],
                artifactOutputs: [],
              },
            ],
            edges: [],
            artifacts: {},
            output: {
              $expr: { type: 'node-output', nodeId: 'writer', path: [] },
            },
          },
        },
        input: { graphInput: {} },
      },
    });
    const runId = started.json<{ runId: string }>().runId;
    const run = await waitForRun(application, runId);

    expect(run.status).toBe('completed');
    expect(run.checkpoint?.state.output).toBe('Nested agent result.');
    await application.close();
  });
});

function toolAgent(id: string, capabilities: readonly string[]) {
  return {
    kind: 'tool-agent' as const,
    id,
    name: id,
    scope: { capabilities },
    reviewLevel: 'never' as const,
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dagent-agents-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function waitForRun(
  application: Application,
  runId: string,
): Promise<{
  status: string;
  checkpoint?: { state: { output?: unknown } };
}> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await application.server.inject({
      method: 'GET',
      url: `/api/v1/runs/${runId}`,
    });
    const run = response.json<{
      status: string;
      checkpoint?: { state: { output?: unknown } };
    }>();
    if (run.status !== 'running') return run;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(`Run '${runId}' did not finish.`);
}
