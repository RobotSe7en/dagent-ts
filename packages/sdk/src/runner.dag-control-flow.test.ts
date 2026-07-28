import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { tool } from './capabilities/tool.js';
import type { CapabilityBinding } from './capabilities/tool.js';
import { defineStaticDag } from './contracts/agents.js';
import type { DAGSpec, DagNode, JsonObject, RunOutcome, ValueBinding } from './contracts/index.js';
import { validateDag } from './domain/dag-validation.js';
import { Runner } from './runner.js';
import { MockProvider } from './testing/mock-provider.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const score = tool({
  id: 'tool.score',
  input: z.object({ text: z.string() }),
  output: z.object({ score: z.number() }),
  execute: ({ text }) => ({ score: text.includes('good') ? 0.9 : 0.1 }),
});

const publish = tool({
  id: 'tool.publish',
  input: z.object({ content: z.string() }),
  output: z.string(),
  execute: ({ content }) => `published:${content}`,
});

const revise = tool({
  id: 'tool.revise',
  input: z.object({ content: z.string() }),
  output: z.string(),
  execute: ({ content }) => `revised:${content}`,
});

const render = tool({
  id: 'tool.render',
  input: z.object({ a: z.string().nullable(), b: z.string().nullable() }),
  output: z.string(),
  execute: ({ a, b }) => `${String(a)}|${String(b)}`,
});

describe('static DAG control flow', () => {
  it('keeps externalized capability values usable by downstream nodes', async () => {
    const produce = tool({
      id: 'tool.produce-large',
      input: z.object({}).strict(),
      output: z.object({ payload: z.string() }).strict(),
      execute: () => ({ payload: 'z'.repeat(5_000) }),
    });
    const consume = tool({
      id: 'tool.consume-large',
      input: z.object({ value: z.object({ payload: z.string() }) }).strict(),
      output: z.number().int(),
      execute: ({ value }) => value.payload.length,
    });
    const graph: DAGSpec = {
      schemaVersion: 1,
      id: 'externalized_dataflow',
      name: 'Externalized dataflow',
      description: '',
      artifacts: {},
      nodes: [
        capabilityNode('produce', 'tool.produce-large', {}),
        capabilityNode('consume', 'tool.consume-large', {
          value: nodeOutput('produce'),
        }),
      ],
      edges: [{ from: 'produce', to: 'consume' }],
      output: nodeOutput('consume'),
    };
    const directory = await temporaryDirectory();
    const runner = new Runner({
      provider: new MockProvider([]),
      capabilities: [produce, consume],
      workspace: directory,
      resultStorage: { maxInlineBytes: 1_024 },
    });

    try {
      const outcome = await runner.run(defineStaticDag(graph), {});

      expect(outcome.status, outcome.state.error).toBe('completed');
      expect(outcome.state.output).toBe(5_000);
      expect(outcome.state.nodeResults['produce']).toMatchObject({
        output: { type: 'dagent_content_reference' },
        valueReference: { type: 'dagent_content_reference' },
      });
    } finally {
      await runner.close();
    }
  });

  it('keeps an externalized map aggregate usable by a downstream node', async () => {
    const produce = tool({
      id: 'tool.produce-map-value',
      input: z.object({ seed: z.string() }).strict(),
      output: z.object({ seed: z.string(), payload: z.string() }).strict(),
      execute: ({ seed }) => ({ seed, payload: 'z'.repeat(5_000) }),
    });
    const consume = tool({
      id: 'tool.consume-map-values',
      input: z.object({
        values: z.array(z.object({ seed: z.string(), payload: z.string() })),
      }),
      output: z.string(),
      execute: ({ values }) =>
        values.map(({ seed, payload }) => `${seed}:${String(payload.length)}`).join(','),
    });
    const child: DAGSpec = {
      schemaVersion: 1,
      id: 'produce_one_large_value',
      name: 'Produce one large value',
      description: '',
      artifacts: {},
      nodes: [
        capabilityNode('produce_one', 'tool.produce-map-value', {
          seed: { $expr: { type: 'item', path: [] } },
        }),
      ],
      edges: [],
      output: nodeOutput('produce_one'),
    };
    const graph: DAGSpec = {
      schemaVersion: 1,
      id: 'externalized_map_dataflow',
      name: 'Externalized map dataflow',
      description: '',
      artifacts: {},
      nodes: [
        {
          id: 'produce_all',
          kind: 'map',
          description: '',
          items: graphInput('seeds'),
          graph: child,
          concurrency: 2,
          maxItems: 10,
          artifactInputs: [],
          artifactOutputs: [],
        },
        capabilityNode('consume', 'tool.consume-map-values', {
          values: nodeOutput('produce_all'),
        }),
      ],
      edges: [{ from: 'produce_all', to: 'consume' }],
      output: nodeOutput('consume'),
    };
    const directory = await temporaryDirectory();
    const runner = new Runner({
      provider: new MockProvider([]),
      capabilities: [produce, consume],
      workspace: directory,
      resultStorage: { maxInlineBytes: 1_024 },
    });

    try {
      const outcome = await runner.run(defineStaticDag(graph), {
        graphInput: { seeds: ['a', 'b'] },
      });

      expect(outcome.status, outcome.state.error).toBe('completed');
      expect(outcome.state.output).toBe('a:5000,b:5000');
      expect(outcome.state.nodeResults['produce_all']).toMatchObject({
        output: { type: 'dagent_content_reference' },
        valueReference: { type: 'dagent_content_reference' },
      });
      const parentResult = outcome.state.nodeResults['produce_all'];
      expect(Buffer.byteLength(parentResult?.content ?? '', 'utf8')).toBeLessThan(1_024);
      expect(parentResult?.content).not.toContain('z'.repeat(5_000));
      expect(JSON.stringify(outcome.checkpoint)).not.toContain('z'.repeat(5_000));
    } finally {
      await runner.close();
    }
  });

  it.each([
    ['good text', 'published:good text|null', 'completed', 'skipped'],
    ['bad text', 'null|revised:bad text', 'skipped', 'completed'],
  ] as const)(
    'takes the live conditional branch for %s and joins after all branches settle',
    async (text, expected, publishStatus, reviseStatus) => {
      const outcome = await runStatic(branchingGraph(), { text }, [score, publish, revise, render]);

      expect(outcome.status).toBe('completed');
      expect(outcome.state.output).toBe(expected);
      expect(outcome.state.nodeResults['publish']?.status).toBe(publishStatus);
      expect(outcome.state.nodeResults['revise']?.status).toBe(reviseStatus);
    },
  );

  it('cascades a skipped branch through downstream-only nodes', async () => {
    const graph: DAGSpec = {
      schemaVersion: 1,
      id: 'skip_cascade',
      name: 'Skip cascade',
      description: '',
      artifacts: {},
      nodes: [
        capabilityNode('score', 'tool.score', {
          text: graphInput('text'),
        }),
        capabilityNode('publish', 'tool.publish', {
          content: graphInput('text'),
        }),
        capabilityNode('announce', 'tool.publish', {
          content: nodeOutput('publish'),
        }),
      ],
      edges: [
        {
          from: 'score',
          to: 'publish',
          condition: {
            operator: 'gte',
            left: nodeOutput('score', 'score'),
            right: 0.8,
          },
        },
        { from: 'publish', to: 'announce' },
      ],
      output: nodeOutput('announce'),
    };

    const outcome = await runStatic(graph, { text: 'bad' }, [score, publish]);

    expect(outcome.status, outcome.state.error).toBe('completed');
    expect(outcome.state.nodeResults['publish']?.status).toBe('skipped');
    expect(outcome.state.nodeResults['announce']?.status).toBe('skipped');
    expect(outcome.state.output).toBeNull();
  });

  it('fans a map node out with bounded concurrency and item expressions', async () => {
    const fetch = tool({
      id: 'tool.fetch',
      input: z.object({ url: z.string() }),
      output: z.string(),
      execute: ({ url }) => `page:${url}`,
    });
    const child: DAGSpec = {
      schemaVersion: 1,
      id: 'fetch_one',
      name: 'Fetch one',
      description: '',
      artifacts: {},
      nodes: [
        capabilityNode('fetch', 'tool.fetch', {
          url: { $expr: { type: 'item', path: ['url'] } },
        }),
      ],
      edges: [],
      output: nodeOutput('fetch'),
    };
    const graph: DAGSpec = {
      schemaVersion: 1,
      id: 'fetch_all',
      name: 'Fetch all',
      description: '',
      artifacts: {},
      nodes: [
        {
          id: 'all',
          kind: 'map',
          description: '',
          items: graphInput('urls'),
          graph: child,
          concurrency: 2,
          maxItems: 3,
          artifactInputs: [],
          artifactOutputs: [],
        },
      ],
      edges: [],
      output: nodeOutput('all'),
    };

    const completed = await runStatic(graph, { urls: [{ url: 'a' }, { url: 'b' }] }, [fetch]);
    const overLimit = await runStatic(
      graph,
      { urls: [{ url: 'a' }, { url: 'b' }, { url: 'c' }, { url: 'd' }] },
      [fetch],
    );

    expect(completed.status).toBe('completed');
    expect(completed.state.output).toEqual(['page:a', 'page:b']);
    expect(overLimit.status).toBe('failed');
    expect(overLimit.state.error).toMatch(/maxItems is 3/u);
  });

  it('runs a subgraph and returns its declared output', async () => {
    const child: DAGSpec = {
      schemaVersion: 1,
      id: 'child',
      name: 'Child',
      description: '',
      artifacts: {},
      nodes: [
        capabilityNode('publish', 'tool.publish', {
          content: graphInput('content'),
        }),
      ],
      edges: [],
      output: nodeOutput('publish'),
    };
    const graph: DAGSpec = {
      schemaVersion: 1,
      id: 'parent',
      name: 'Parent',
      description: '',
      artifacts: {},
      nodes: [
        {
          id: 'nested',
          kind: 'subgraph',
          description: '',
          graph: child,
          input: { content: graphInput('text') },
          artifactInputs: [],
          artifactOutputs: [],
        },
      ],
      edges: [],
      output: nodeOutput('nested'),
    };

    const outcome = await runStatic(graph, { text: 'hello' }, [publish]);

    expect(outcome.status).toBe('completed');
    expect(outcome.state.output).toBe('published:hello');
  });

  it('returns the last bounded loop value when its condition remains false', async () => {
    const increment = tool({
      id: 'tool.increment',
      input: z.object({ n: z.number().int() }),
      output: z.object({ n: z.number().int() }),
      execute: ({ n }) => ({ n: n + 1 }),
    });
    const child: DAGSpec = {
      schemaVersion: 1,
      id: 'increment_once',
      name: 'Increment once',
      description: '',
      artifacts: {},
      nodes: [
        capabilityNode('increment', 'tool.increment', {
          n: graphInput('n'),
        }),
      ],
      edges: [],
      output: nodeOutput('increment'),
    };
    const graph: DAGSpec = {
      schemaVersion: 1,
      id: 'bounded_loop',
      name: 'Bounded loop',
      description: '',
      artifacts: {},
      nodes: [
        {
          id: 'loop',
          kind: 'loop',
          description: '',
          graph: child,
          input: graphInput('state'),
          until: {
            operator: 'gte',
            left: { $expr: { type: 'item', path: ['n'] } },
            right: 100,
          },
          maxIterations: 4,
          artifactInputs: [],
          artifactOutputs: [],
        },
      ],
      edges: [],
      output: nodeOutput('loop'),
    };

    const outcome = await runStatic(graph, { state: { n: 0 } }, [increment]);

    expect(outcome.status, outcome.state.error).toBe('completed');
    expect(outcome.state.output).toEqual({ n: 4 });
  });

  it('requires review for high-risk capabilities nested in a subgraph', async () => {
    const deploy = tool({
      id: 'tool.deploy',
      input: z.object({ target: z.string() }),
      output: z.string(),
      risk: 'high',
      execute: ({ target }) => `deployed:${target}`,
    });
    const child: DAGSpec = {
      schemaVersion: 1,
      id: 'deployment',
      name: 'Deployment',
      description: '',
      artifacts: {},
      nodes: [
        capabilityNode('deploy', 'tool.deploy', {
          target: graphInput('target'),
        }),
      ],
      edges: [],
      output: nodeOutput('deploy'),
    };
    const graph: DAGSpec = {
      schemaVersion: 1,
      id: 'release',
      name: 'Release',
      description: '',
      artifacts: {},
      nodes: [
        {
          id: 'deployment',
          kind: 'subgraph',
          description: '',
          graph: child,
          input: { target: graphInput('target') },
          artifactInputs: [],
          artifactOutputs: [],
        },
      ],
      edges: [],
    };

    const directory = await temporaryDirectory();
    const runner = new Runner({
      provider: new MockProvider([]),
      capabilities: [deploy],
      workspace: directory,
    });
    try {
      const outcome = await runner.run(defineStaticDag(graph, 'risky'), {
        graphInput: { target: 'production' },
      });
      expect(outcome.status).toBe('awaiting-review');
      expect(outcome.state.pendingReview?.kind).toBe('dag-review');
    } finally {
      await runner.close();
    }
  });
});

describe('control-flow validation', () => {
  it('rejects edge conditions that read a non-upstream node', () => {
    const graph = branchingGraph();
    const result = validateDag({
      ...graph,
      edges: [
        {
          from: 'score',
          to: 'publish',
          condition: {
            operator: 'truthy',
            value: nodeOutput('revise'),
          },
        },
        ...graph.edges.slice(1),
      ],
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'invalid-reference',
            path: 'edges.0.condition.value',
          }),
        ]),
      );
    }
  });

  it('rejects unknown output nodes and item expressions outside bounded control flow', () => {
    const graph = branchingGraph();
    const unknownOutput = validateDag({ ...graph, output: nodeOutput('missing') });
    const invalidItem = validateDag({
      ...graph,
      nodes: [
        capabilityNode('publish', 'tool.publish', {
          content: { $expr: { type: 'item', path: [] } },
        }),
      ],
      edges: [],
      output: nodeOutput('publish'),
    });

    expect(unknownOutput.valid).toBe(false);
    expect(invalidItem.valid).toBe(false);
    if (!unknownOutput.valid) {
      expect(unknownOutput.issues[0]?.message).toMatch(/unknown node 'missing'/u);
    }
    if (!invalidItem.valid) {
      expect(invalidItem.issues[0]?.message).toMatch(/only valid inside map and loop/u);
    }
  });
});

function branchingGraph(): DAGSpec {
  return {
    schemaVersion: 1,
    id: 'branching',
    name: 'Branching',
    description: '',
    artifacts: {},
    nodes: [
      capabilityNode('score', 'tool.score', { text: graphInput('text') }),
      capabilityNode('publish', 'tool.publish', { content: graphInput('text') }),
      capabilityNode('revise', 'tool.revise', { content: graphInput('text') }),
      capabilityNode('join', 'tool.render', {
        a: nodeOutput('publish'),
        b: nodeOutput('revise'),
      }),
    ],
    edges: [
      {
        from: 'score',
        to: 'publish',
        condition: {
          operator: 'gte',
          left: nodeOutput('score', 'score'),
          right: 0.8,
        },
      },
      {
        from: 'score',
        to: 'revise',
        condition: {
          operator: 'lt',
          left: nodeOutput('score', 'score'),
          right: 0.8,
        },
      },
      { from: 'publish', to: 'join' },
      { from: 'revise', to: 'join' },
    ],
    output: nodeOutput('join'),
  };
}

function capabilityNode(
  id: string,
  capabilityId: string,
  arguments_: Readonly<Record<string, ValueBinding>>,
): Extract<DagNode, { readonly kind: 'capability' }> {
  return {
    id,
    kind: 'capability',
    description: '',
    capabilityId,
    arguments: arguments_,
    artifactInputs: [],
    artifactOutputs: [],
  };
}

function graphInput(path: string) {
  return { $expr: { type: 'graph-input' as const, path: [path] } };
}

function nodeOutput(nodeId: string, ...path: string[]) {
  return { $expr: { type: 'node-output' as const, nodeId, path } };
}

async function runStatic(
  graph: DAGSpec,
  graphInputValue: JsonObject,
  capabilities: readonly CapabilityBinding[],
): Promise<RunOutcome> {
  const directory = await temporaryDirectory();
  const runner = new Runner({
    provider: new MockProvider([]),
    capabilities,
    workspace: directory,
  });
  try {
    return await runner.run(defineStaticDag(graph), { graphInput: graphInputValue });
  } finally {
    await runner.close();
  }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dagent-control-flow-'));
  temporaryDirectories.push(directory);
  return directory;
}
