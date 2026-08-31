import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { tool } from '../capabilities/tool.js';
import type { DAGSpec, DagDesignEvent } from '../contracts/index.js';
import { Runner } from '../runner.js';
import type { ChatProvider } from '../providers/provider.js';
import { MockProvider } from '../testing/mock-provider.js';
import { inspectDag } from './dag-design.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('non-executing DAG design', () => {
  it('retains the non-streaming provider path when no event listener is supplied', async () => {
    let streamCalled = false;
    const provider = {
      async chat() {
        return {
          content: JSON.stringify({ action: 'answer', answer: 'The graph is design-only.' }),
          reasoningContent: '',
          refusal: '',
          toolCalls: [],
        };
      },
      streamChat() {
        streamCalled = true;
        throw new Error('Unexpected design stream.');
      },
    } satisfies ChatProvider;
    const workspace = await temporaryDirectory();
    const runner = new Runner({ provider, workspace });

    const result = await runner.designDag('Explain the design boundary.');

    expect(result).toMatchObject({ type: 'answer', answer: 'The graph is design-only.' });
    expect(streamCalled).toBe(false);
    await runner.close();
  });

  it('returns a validated proposal with natural visible content and lifecycle events', async () => {
    let invocations = 0;
    const echo = tool({
      id: 'tool.echo-design',
      input: z.object({ text: z.string() }).strict(),
      output: z.string(),
      execute: ({ text }) => {
        invocations += 1;
        return text;
      },
    });
    const graph = echoGraph();
    const provider = new MockProvider([
      {
        content: JSON.stringify({
          action: 'propose',
          candidate: graph,
          summary: 'Created an echo workflow.',
        }),
        reasoningContent: 'Checking the catalog.',
        refusal: '',
        toolCalls: [],
      },
    ]);
    const workspace = await temporaryDirectory();
    const runner = new Runner({ provider, capabilities: [echo], workspace });
    const events: DagDesignEvent[] = [];

    const result = await runner.designDag('Create an echo workflow.', {
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(result.type).toBe('proposal');
    if (result.type !== 'proposal') throw new Error(`Unexpected type: ${result.type}`);
    expect(result.candidate).toEqual(graph);
    expect(result.conversation.items.at(-1)).toMatchObject({
      type: 'assistant',
      content: 'Created an echo workflow.',
      visibility: 'user',
    });
    expect(invocations).toBe(0);
    expect(events.map(({ type }) => type)).toEqual([
      'response-started',
      'reasoning-delta',
      'response-finished',
      'validation-started',
      'validation-passed',
    ]);
    expect(events.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(events.every((event) => !('runId' in event))).toBe(true);
    await runner.close();
  });

  it('returns typed no-change, answer, failure, and deterministic inspection results', async () => {
    const graph = echoGraph();
    const provider = new MockProvider([
      {
        content: JSON.stringify({ action: 'no-change', summary: 'It is already correct.' }),
        reasoningContent: '',
        refusal: '',
        toolCalls: [],
      },
      {
        content: JSON.stringify({ action: 'answer', answer: 'It has one step.' }),
        reasoningContent: '',
        refusal: '',
        toolCalls: [],
      },
    ]);
    const workspace = await temporaryDirectory();
    const echo = tool({
      id: 'tool.echo-design',
      input: z.object({ text: z.string() }).strict(),
      output: z.string(),
      execute: ({ text }) => text,
    });
    const runner = new Runner({ provider, capabilities: [echo], workspace });

    const unchanged = await runner.designDag('Keep it.', { current: graph });
    const answer = await runner.designDag('Explain it.', { current: graph });
    const failure = await runner.designDag('Edit the selected node.', {
      current: graph,
      selection: { nodeIds: ['missing'] },
    });
    const invalid = { ...graph, edges: [{ from: 'missing', to: 'echo' }] };

    expect(unchanged.type).toBe('no-change');
    expect(answer.type).toBe('answer');
    expect(failure.type).toBe('failure');
    expect(failure.diagnostics[0]?.code).toBe('dag-design.selection-unknown-node');
    expect(inspectDag(invalid)).toEqual(inspectDag(invalid));
    expect(inspectDag(invalid)[0]).toMatchObject({ severity: 'error' });
    expect(provider.requests).toHaveLength(2);
    await runner.close();
  });
});

function echoGraph(): DAGSpec {
  return {
    schemaVersion: 1,
    id: 'echo_graph',
    name: 'Echo graph',
    description: '',
    nodes: [
      {
        id: 'echo',
        kind: 'capability',
        description: '',
        capabilityId: 'tool.echo-design',
        arguments: { text: 'hello' },
        artifactInputs: [],
        artifactOutputs: [],
      },
    ],
    edges: [],
    artifacts: {},
    output: { $expr: { type: 'node-output', nodeId: 'echo', path: [] } },
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dagent-dag-design-'));
  temporaryDirectories.push(directory);
  return directory;
}
