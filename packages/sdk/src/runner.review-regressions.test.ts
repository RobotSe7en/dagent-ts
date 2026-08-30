import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { tool } from './capabilities/tool.js';
import { defineDagAgent, defineStaticDag, defineToolAgent } from './contracts/agents.js';
import type { DAGSpec } from './contracts/index.js';
import { Runner } from './runner.js';
import { MockProvider } from './testing/mock-provider.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('review and execution-scope regressions', () => {
  it('rejects a reviewed replacement graph that adds an out-of-scope capability', async () => {
    let outsideInvocations = 0;
    const allowed = stringTool('tool.allowed', () => 'allowed');
    const outside = stringTool('tool.outside', () => {
      outsideInvocations += 1;
      return 'outside';
    });
    const runner = await testRunner(new MockProvider([]), {
      capabilities: [allowed, outside],
    });
    const first = await runner.run(defineStaticDag(capabilityGraph('tool.allowed'), 'always'), {});
    expect(first.status).toBe('awaiting-review');
    if (first.status !== 'awaiting-review') return;

    const resumed = await runner.resume(first.checkpoint, {
      reviewId: first.review.id,
      revision: first.review.revision,
      action: 'approve',
      reason: '',
      replacementGraph: capabilityGraph('tool.outside'),
    });

    expect(resumed.status).toBe('failed');
    expect(resumed.state.error).toContain('outside the resolved plan');
    expect(outsideInvocations).toBe(0);
    await runner.close();
  });

  it('rejects an agent node that is not in the DagAgent allowlist', async () => {
    const graph = agentGraph('private_worker');
    const provider = new MockProvider([planReply(graph), planReply(graph)]);
    const worker = defineToolAgent({
      kind: 'tool-agent',
      id: 'private_worker',
      name: 'Private worker',
      scope: {},
      reviewLevel: 'never',
    });
    const runner = await testRunner(provider, { agents: [worker] });
    const planner = defineDagAgent({
      kind: 'dag-agent',
      id: 'planner',
      name: 'Planner',
      scope: { agents: [] },
      reviewLevel: 'never',
      maxReplans: 0,
    });

    const outcome = await runner.run(planner, { prompt: 'delegate' });

    expect(outcome.status).toBe('failed');
    expect(outcome.state.error).toContain("unavailable agent 'private_worker'");
    expect(provider.requests).toHaveLength(2);
    await runner.close();
  });

  it('rejects resume when a reviewed agent definition changed', async () => {
    const firstWorker = defineToolAgent({
      kind: 'tool-agent',
      id: 'worker',
      name: 'Worker',
      systemPrompt: 'Original definition.',
      scope: {},
      reviewLevel: 'never',
    });
    const runner = await testRunner(new MockProvider([]), { agents: [firstWorker] });
    const first = await runner.run(defineStaticDag(agentGraph('worker'), 'always'), {});
    expect(first.status).toBe('awaiting-review');
    if (first.status !== 'awaiting-review') return;
    runner.replaceAgent({
      ...firstWorker,
      systemPrompt: 'Changed after review.',
    });

    await expect(
      runner.resume(first.checkpoint, {
        reviewId: first.review.id,
        revision: first.review.revision,
        action: 'approve',
        reason: '',
      }),
    ).rejects.toMatchObject({ code: 'CHECKPOINT_MISMATCH' });
    await runner.close();
  });

  it('suspends and resumes a direct static DAG ToolAgent capability review', async () => {
    let invocations = 0;
    const reviewed = stringTool(
      'tool.static-reviewed',
      () => {
        invocations += 1;
        return 'approved';
      },
      'high',
    );
    const provider = new MockProvider([
      {
        content: '',
        reasoningContent: '',
        refusal: '',
        toolCalls: [{ id: 'call-static', name: 'tool.static-reviewed', arguments: {} }],
      },
      {
        content: 'agent complete',
        reasoningContent: '',
        refusal: '',
        toolCalls: [],
      },
    ]);
    const worker = defineToolAgent({
      kind: 'tool-agent',
      id: 'review_worker',
      name: 'Review worker',
      scope: { capabilities: ['tool.static-reviewed'] },
      reviewLevel: 'risky',
    });
    const runner = await testRunner(provider, { capabilities: [reviewed], agents: [worker] });

    const pending = await runner.run(defineStaticDag(agentGraph('review_worker')), {});

    expect(pending.status).toBe('awaiting-review');
    if (pending.status !== 'awaiting-review') return;
    expect(pending.review.kind).toBe('capability-review');
    expect(pending.state.staticAgentContinuation).toMatchObject({
      nodeId: 'delegate',
      agentId: 'review_worker',
      invocation: { capabilityId: 'tool.static-reviewed' },
    });

    const completed = await runner.resume(pending.checkpoint, {
      reviewId: pending.review.id,
      revision: pending.review.revision,
      action: 'approve',
      reason: '',
    });

    expect(completed.status).toBe('completed');
    expect(completed.state.output).toBe('agent complete');
    expect(completed.state.staticAgentContinuation).toBeUndefined();
    expect(invocations).toBe(1);
    await runner.close();
  });

  it('rejects static agent continuation inside nested DAG constructs', async () => {
    const worker = defineToolAgent({
      kind: 'tool-agent',
      id: 'nested_worker',
      name: 'Nested worker',
      scope: {},
      reviewLevel: 'never',
    });
    const nested = agentGraph('nested_worker');
    const graph: DAGSpec = {
      schemaVersion: 1,
      id: 'nested_agent_graph',
      name: 'Nested agent graph',
      description: '',
      nodes: [
        {
          id: 'nested',
          kind: 'subgraph',
          description: '',
          graph: nested,
          input: {},
          artifactInputs: [],
          artifactOutputs: [],
        },
      ],
      edges: [],
      artifacts: {},
    };
    const runner = await testRunner(new MockProvider([]), { agents: [worker] });

    await expect(runner.run(defineStaticDag(graph), {})).rejects.toThrow(/direct top-level/u);
    await runner.close();
  });

  it('adds skipped results for later calls when an earlier call requires review', async () => {
    let reviewedInvocations = 0;
    let laterInvocations = 0;
    const reviewed = stringTool(
      'tool.reviewed',
      () => {
        reviewedInvocations += 1;
        return 'reviewed';
      },
      'high',
    );
    const later = stringTool('tool.later', () => {
      laterInvocations += 1;
      return 'later';
    });
    const provider = new MockProvider([
      {
        content: '',
        reasoningContent: '',
        refusal: '',
        toolCalls: [
          { id: 'call-reviewed', name: 'tool.reviewed', arguments: {} },
          { id: 'call-later', name: 'tool.later', arguments: {} },
        ],
      },
      {
        content: 'done',
        reasoningContent: '',
        refusal: '',
        toolCalls: [],
      },
    ]);
    const runner = await testRunner(provider, { capabilities: [reviewed, later] });
    const agent = defineToolAgent({
      kind: 'tool-agent',
      id: 'assistant',
      name: 'Assistant',
      scope: { capabilities: ['tool.reviewed', 'tool.later'] },
      reviewLevel: 'risky',
    });
    const first = await runner.run(agent, { prompt: 'run both' });
    expect(first.status).toBe('awaiting-review');
    if (first.status !== 'awaiting-review') return;
    expect(
      first.state.conversation?.items.find(
        (item) => item.type === 'tool-result' && item.callId === 'call-later',
      ),
    ).toMatchObject({ status: 'skipped' });

    const resumed = await runner.resume(first.checkpoint, {
      reviewId: first.review.id,
      revision: first.review.revision,
      action: 'approve',
      reason: '',
    });

    expect(resumed.status).toBe('completed');
    expect(reviewedInvocations).toBe(1);
    expect(laterInvocations).toBe(0);
    const toolCallIds = provider.requests[1]?.messages.flatMap((message) =>
      message.role === 'tool' && message.toolCallId !== undefined ? [message.toolCallId] : [],
    );
    expect(toolCallIds).toEqual(expect.arrayContaining(['call-reviewed', 'call-later']));
    await runner.close();
  });

  it('preserves the reviewed tool result if the following provider request fails', async () => {
    let invocations = 0;
    const reviewed = stringTool(
      'tool.side-effect',
      () => {
        invocations += 1;
        return 'written';
      },
      'high',
    );
    const provider = new MockProvider([
      {
        content: '',
        reasoningContent: '',
        refusal: '',
        toolCalls: [{ id: 'call-side-effect', name: 'tool.side-effect', arguments: {} }],
      },
      () => {
        throw new Error('provider unavailable');
      },
    ]);
    const runner = await testRunner(provider, { capabilities: [reviewed] });
    const agent = defineToolAgent({
      kind: 'tool-agent',
      id: 'assistant',
      name: 'Assistant',
      scope: { capabilities: ['tool.side-effect'] },
      reviewLevel: 'risky',
    });
    const first = await runner.run(agent, { prompt: 'write' });
    expect(first.status).toBe('awaiting-review');
    if (first.status !== 'awaiting-review') return;

    const resumed = await runner.resume(first.checkpoint, {
      reviewId: first.review.id,
      revision: first.review.revision,
      action: 'approve',
      reason: '',
    });

    expect(resumed.status).toBe('failed');
    expect(invocations).toBe(1);
    expect(
      resumed.state.conversation?.items.find(
        (item) => item.type === 'tool-result' && item.callId === 'call-side-effect',
      ),
    ).toMatchObject({ status: 'completed' });
    await runner.close();
  });

  it('reuses an approved boundary path only within the resumed run', async () => {
    let invocations = 0;
    const bounded = tool({
      id: 'tool.bounded-write',
      input: z.object({ path: z.string() }).strict(),
      output: z.string(),
      boundary: { workspaceWrite: true, allowedPaths: ['allowed'] },
      execute: ({ path }) => {
        invocations += 1;
        return path;
      },
    });
    const provider = new MockProvider([
      {
        content: '',
        reasoningContent: '',
        refusal: '',
        toolCalls: [
          {
            id: 'call-boundary-1',
            name: 'tool.bounded-write',
            arguments: { path: 'blocked/note.txt' },
          },
        ],
      },
      {
        content: '',
        reasoningContent: '',
        refusal: '',
        toolCalls: [
          {
            id: 'call-boundary-2',
            name: 'tool.bounded-write',
            arguments: { path: 'blocked/note.txt' },
          },
        ],
      },
      { content: 'done', reasoningContent: '', refusal: '', toolCalls: [] },
    ]);
    const runner = await testRunner(provider, { capabilities: [bounded] });
    const agent = defineToolAgent({
      kind: 'tool-agent',
      id: 'boundary_agent',
      name: 'Boundary agent',
      scope: { capabilities: ['tool.bounded-write'] },
      reviewLevel: 'never',
    });

    const first = await runner.run(agent, { prompt: 'write twice' });

    expect(first.status).toBe('awaiting-review');
    if (first.status !== 'awaiting-review') return;
    expect(first.review.metadata).toEqual({
      reason: 'boundary-violation',
      boundaryPaths: ['blocked/note.txt'],
      approvedBoundaryPaths: [],
    });
    expect(invocations).toBe(0);

    const resumed = await runner.resume(first.checkpoint, {
      reviewId: first.review.id,
      revision: first.review.revision,
      action: 'approve',
      reason: '',
    });

    expect(resumed.status).toBe('completed');
    expect(invocations).toBe(2);
    await runner.close();
  });

  it('freezes the effective skill scope and rejects resume after a skill disappears', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dagent-skill-scope-'));
    temporaryDirectories.push(workspace);
    const skillDirectory = join(workspace, 'skills', 'reporting');
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(
      join(skillDirectory, 'SKILL.md'),
      '---\nname: reporting\ndescription: Reporting workflow\n---\n\nUse reports.',
    );
    const reviewed = stringTool('tool.reviewed-skill', () => 'done', 'high');
    const provider = new MockProvider([
      {
        content: '',
        reasoningContent: '',
        refusal: '',
        toolCalls: [{ id: 'call-skill', name: 'tool.reviewed-skill', arguments: {} }],
      },
    ]);
    const runner = new Runner({
      provider,
      capabilities: [reviewed],
      workspace,
      runtimeDirectory: '.runtime',
      skillRoots: [join(workspace, 'skills')],
      managedSkillRoot: join(workspace, 'managed-skills'),
    });
    const agent = defineToolAgent({
      kind: 'tool-agent',
      id: 'assistant',
      name: 'Assistant',
      scope: { capabilities: ['tool.reviewed-skill'], skills: ['reporting'] },
      reviewLevel: 'risky',
    });
    const first = await runner.run(agent, { prompt: 'use the workflow' });
    expect(first.status).toBe('awaiting-review');
    if (first.status !== 'awaiting-review') return;
    expect(first.checkpoint.plan.skillIds).toEqual(['reporting']);
    expect(first.checkpoint.plan.capabilityIds).toEqual(
      expect.arrayContaining(['skill.list', 'skill.view']),
    );
    await rm(skillDirectory, { recursive: true });

    await expect(
      runner.resume(first.checkpoint, {
        reviewId: first.review.id,
        revision: first.review.revision,
        action: 'approve',
        reason: '',
      }),
    ).rejects.toMatchObject({ code: 'CHECKPOINT_MISMATCH' });
    await runner.close();
  });

  it('reruns explicitly selected completed nodes and their downstream nodes', async () => {
    let sourceInvocations = 0;
    let sinkInvocations = 0;
    const source = tool({
      id: 'tool.source',
      input: z.object({ version: z.number().int() }).strict(),
      output: z.number().int(),
      execute: ({ version }) => {
        sourceInvocations += 1;
        return version;
      },
    });
    const sink = stringTool('tool.sink', () => {
      sinkInvocations += 1;
      if (sinkInvocations === 1) throw new Error('retry');
      return 'done';
    });
    const initial = replanGraph(1);
    const replacement = replanGraph(2);
    const provider = new MockProvider([
      planReply(initial),
      {
        content: JSON.stringify({
          graph: replacement,
          rationale: 'Use the corrected source.',
          rerunNodeIds: ['source'],
        }),
        reasoningContent: '',
        refusal: '',
        toolCalls: [],
      },
    ]);
    const runner = await testRunner(provider, { capabilities: [source, sink] });
    const planner = defineDagAgent({
      kind: 'dag-agent',
      id: 'planner',
      name: 'Planner',
      scope: { capabilities: ['tool.source', 'tool.sink'] },
      reviewLevel: 'never',
      maxReplans: 1,
    });

    const outcome = await runner.run(planner, { prompt: 'run' });

    expect(outcome.status).toBe('completed');
    expect(sourceInvocations).toBe(2);
    expect(sinkInvocations).toBe(2);
    await runner.close();
  });
});

function stringTool(id: `tool.${string}`, execute: () => string, risk: 'low' | 'high' = 'low') {
  return tool({
    id,
    input: z.object({}).strict(),
    output: z.string(),
    risk,
    execute,
  });
}

function capabilityGraph(capabilityId: string): DAGSpec {
  return {
    schemaVersion: 1,
    id: 'capability_graph',
    name: 'Capability graph',
    description: '',
    nodes: [
      {
        id: 'work',
        kind: 'capability',
        description: '',
        capabilityId,
        arguments: {},
        artifactInputs: [],
        artifactOutputs: [],
      },
    ],
    edges: [],
    artifacts: {},
    output: { $expr: { type: 'node-output', nodeId: 'work', path: [] } },
  };
}

function agentGraph(agentId: string): DAGSpec {
  return {
    schemaVersion: 1,
    id: 'agent_graph',
    name: 'Agent graph',
    description: '',
    nodes: [
      {
        id: 'delegate',
        kind: 'agent',
        description: '',
        agentId,
        prompt: 'work',
        artifactInputs: [],
        artifactOutputs: [],
      },
    ],
    edges: [],
    artifacts: {},
    output: { $expr: { type: 'node-output', nodeId: 'delegate', path: [] } },
  };
}

function replanGraph(version: number): DAGSpec {
  return {
    schemaVersion: 1,
    id: 'replan_graph',
    name: 'Replan graph',
    description: '',
    nodes: [
      {
        id: 'source',
        kind: 'capability',
        description: '',
        capabilityId: 'tool.source',
        arguments: { version },
        artifactInputs: [],
        artifactOutputs: [],
      },
      {
        id: 'sink',
        kind: 'capability',
        description: '',
        capabilityId: 'tool.sink',
        arguments: {},
        artifactInputs: [],
        artifactOutputs: [],
      },
    ],
    edges: [{ from: 'source', to: 'sink' }],
    artifacts: {},
    output: { $expr: { type: 'node-output', nodeId: 'sink', path: [] } },
  };
}

function planReply(graph: DAGSpec) {
  return {
    content: JSON.stringify({ graph, rationale: '', rerunNodeIds: [] }),
    reasoningContent: '',
    refusal: '',
    toolCalls: [],
  };
}

async function testRunner(
  provider: MockProvider,
  options: Pick<ConstructorParameters<typeof Runner>[0], 'capabilities' | 'agents'> = {},
): Promise<Runner> {
  const workspace = await mkdtemp(join(tmpdir(), 'dagent-review-regression-'));
  temporaryDirectories.push(workspace);
  return new Runner({
    provider,
    workspace,
    runtimeDirectory: '.runtime',
    ...options,
  });
}
