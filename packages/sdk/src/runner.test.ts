import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { defineDagAgent, defineToolAgent } from './contracts/agents.js';
import { tool } from './capabilities/tool.js';
import { Runner } from './runner.js';
import { MockProvider } from './testing/mock-provider.js';

describe('Runner tool agent', () => {
  it('executes a typed capability and records provider-neutral history', async () => {
    const echo = tool({
      id: 'tool.echo',
      input: z.object({ text: z.string() }).strict(),
      output: z.object({ text: z.string() }).strict(),
      execute: ({ text }) => ({ text }),
    });
    const provider = new MockProvider([
      {
        content: '',
        reasoningContent: '',
        refusal: '',
        toolCalls: [{ id: 'call-1', name: 'tool.echo', arguments: { text: 'hello' } }],
      },
      {
        content: 'done',
        reasoningContent: '',
        refusal: '',
        toolCalls: [],
      },
    ]);
    const runner = new Runner({
      provider,
      capabilities: [echo],
    });
    const agent = defineToolAgent({
      kind: 'tool-agent',
      id: 'assistant',
      name: 'Assistant',
      systemPrompt: 'Help.',
      scope: { capabilities: ['tool.echo'] },
      reviewLevel: 'never',
    });

    const outcome = await runner.run(agent, { prompt: 'go' });

    expect(outcome.status).toBe('completed');
    expect(outcome.state.conversation?.items.map(({ type }) => type)).toEqual([
      'user',
      'assistant',
      'tool-result',
      'assistant',
    ]);
    expect(outcome.state.modelThread).toEqual(outcome.state.conversation);
    expect(provider.requests).toHaveLength(2);
    await runner.close();
  });

  it('returns invalid tool arguments to the model for one-step repair', async () => {
    let invocations = 0;
    const repeat = tool({
      id: 'tool.repeat',
      input: z.object({ count: z.number().int().positive() }).strict(),
      output: z.object({ count: z.number().int() }).strict(),
      execute: ({ count }) => {
        invocations += 1;
        return { count };
      },
    });
    const provider = new MockProvider([
      {
        content: '',
        reasoningContent: '',
        refusal: '',
        toolCalls: [{ id: 'bad-call', name: 'tool.repeat', arguments: { count: 'two' } }],
      },
      {
        content: '',
        reasoningContent: '',
        refusal: '',
        toolCalls: [{ id: 'good-call', name: 'tool.repeat', arguments: { count: 2 } }],
      },
      {
        content: 'done',
        reasoningContent: '',
        refusal: '',
        toolCalls: [],
      },
    ]);
    const runner = new Runner({ provider, capabilities: [repeat] });
    const agent = defineToolAgent({
      kind: 'tool-agent',
      id: 'assistant',
      name: 'Assistant',
      systemPrompt: 'Repair rejected tool calls.',
      scope: { capabilities: ['tool.repeat'] },
      reviewLevel: 'never',
    });

    const outcome = await runner.run(agent, { prompt: 'repeat twice' });

    expect(outcome.status).toBe('completed');
    expect(invocations).toBe(1);
    expect(outcome.checkpoint.usage).toMatchObject({
      modelCalls: 3,
      capabilityCalls: 1,
    });
    expect(provider.requests[1]?.messages.at(-1)).toMatchObject({
      role: 'tool',
      toolCallId: 'bad-call',
    });
    expect(provider.requests[2]?.messages.at(-1)).toMatchObject({
      role: 'tool',
      toolCallId: 'good-call',
    });
    expect(outcome.state.conversation?.items.map(({ type }) => type)).toEqual([
      'user',
      'assistant',
      'tool-result',
      'assistant',
      'tool-result',
      'assistant',
    ]);
    await runner.close();
  });

  it('resumes a risky capability from an exact checkpoint', async () => {
    const risky = tool({
      id: 'tool.risky',
      input: z.object({}).strict(),
      output: z.literal('ok'),
      risk: 'high',
      execute: () => 'ok' as const,
    });
    const provider = new MockProvider([
      {
        content: '',
        reasoningContent: '',
        refusal: '',
        toolCalls: [{ id: 'call-1', name: 'tool.risky', arguments: {} }],
      },
      {
        content: 'approved',
        reasoningContent: '',
        refusal: '',
        toolCalls: [],
      },
    ]);
    const runner = new Runner({ provider, capabilities: [risky] });
    const agent = defineToolAgent({
      kind: 'tool-agent',
      id: 'assistant',
      name: 'Assistant',
      systemPrompt: 'Help.',
      scope: { capabilities: ['tool.risky'] },
      reviewLevel: 'risky',
    });
    const pending = await runner.run(agent, { prompt: 'go' });
    expect(pending.status).toBe('awaiting-review');
    if (pending.status !== 'awaiting-review') return;

    const completed = await runner.resume(pending.checkpoint, {
      reviewId: pending.review.id,
      revision: pending.review.revision,
      action: 'approve',
      reason: '',
    });

    expect(completed.status).toBe('completed');
    await expect(
      runner.resume(pending.checkpoint, {
        reviewId: pending.review.id,
        revision: pending.review.revision,
        action: 'approve',
        reason: '',
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVIEW' });
    await runner.close();
  });

  it('rejects a review checkpoint after its capability definition changes', async () => {
    const risky = tool({
      id: 'tool.mutable-risky',
      description: 'Original reviewed operation.',
      input: z.object({}).strict(),
      output: z.literal('ok'),
      risk: 'high',
      execute: () => 'ok' as const,
    });
    const provider = new MockProvider([
      {
        content: '',
        reasoningContent: '',
        refusal: '',
        toolCalls: [{ id: 'call-mutable', name: 'tool.mutable-risky', arguments: {} }],
      },
    ]);
    const runner = new Runner({ provider, capabilities: [risky] });
    const agent = defineToolAgent({
      kind: 'tool-agent',
      id: 'mutable-review-agent',
      name: 'Mutable review agent',
      systemPrompt: 'Help.',
      scope: { capabilities: ['tool.mutable-risky'] },
      reviewLevel: 'risky',
    });
    const pending = await runner.run(agent, { prompt: 'go' });
    expect(pending.status).toBe('awaiting-review');
    if (pending.status !== 'awaiting-review') return;
    runner.catalog.replace(
      tool({
        id: 'tool.mutable-risky',
        description: 'Definition changed after review.',
        input: z.object({}).strict(),
        output: z.literal('ok'),
        risk: 'high',
        execute: () => 'ok' as const,
      }),
    );

    await expect(
      runner.resume(pending.checkpoint, {
        reviewId: pending.review.id,
        revision: pending.review.revision,
        action: 'approve',
        reason: '',
      }),
    ).rejects.toMatchObject({ code: 'CHECKPOINT_MISMATCH' });
    await runner.close();
  });

  it('repairs one invalid dynamic plan without retaining the rejected payload', async () => {
    const graph = {
      schemaVersion: 1 as const,
      id: 'empty_graph',
      name: 'Empty graph',
      description: '',
      nodes: [],
      edges: [],
      artifacts: {},
    };
    const provider = new MockProvider([
      {
        content: 'not valid JSON',
        reasoningContent: '',
        refusal: '',
        toolCalls: [],
      },
      {
        content: JSON.stringify({ graph, rationale: 'No work is required.', rerunNodeIds: [] }),
        reasoningContent: '',
        refusal: '',
        toolCalls: [],
      },
    ]);
    const runner = new Runner({ provider });
    const agent = defineDagAgent({
      kind: 'dag-agent',
      id: 'planner',
      name: 'Planner',
      systemPrompt: 'Plan.',
      scope: {},
      reviewLevel: 'never',
      maxReplans: 0,
    });

    const outcome = await runner.run(agent, { prompt: 'do nothing' });

    expect(outcome.status).toBe('completed');
    expect(provider.requests).toHaveLength(2);
    expect(outcome.checkpoint.usage.modelCalls).toBe(2);
    expect(JSON.stringify(outcome.state.modelThread)).not.toContain('not valid JSON');
    expect(provider.requests[1]?.messages.at(-1)?.content).toContain('Repair it');
    await runner.close();
  });

  it('replans a failed dynamic DAG without duplicating the user turn', async () => {
    let invocations = 0;
    const flaky = tool({
      id: 'tool.flaky',
      input: z.object({}).strict(),
      output: z.literal('recovered'),
      execute: () => {
        invocations += 1;
        if (invocations === 1) throw new Error('transient failure');
        return 'recovered' as const;
      },
    });
    const graph = {
      schemaVersion: 1 as const,
      id: 'recovery_graph',
      name: 'Recovery graph',
      description: '',
      nodes: [
        {
          id: 'work',
          kind: 'capability' as const,
          description: '',
          capabilityId: 'tool.flaky',
          arguments: {},
          artifactInputs: [],
          artifactOutputs: [],
        },
      ],
      edges: [],
      artifacts: {},
      output: { $expr: { type: 'node-output' as const, nodeId: 'work', path: [] } },
    };
    const planReply = {
      content: JSON.stringify({ graph, rationale: '', rerunNodeIds: ['work'] }),
      reasoningContent: '',
      refusal: '',
      toolCalls: [],
    };
    const provider = new MockProvider([planReply, planReply]);
    const runner = new Runner({ provider, capabilities: [flaky] });
    const agent = defineDagAgent({
      kind: 'dag-agent',
      id: 'planner',
      name: 'Planner',
      systemPrompt: 'Plan.',
      scope: { capabilities: ['tool.flaky'] },
      reviewLevel: 'never',
      maxReplans: 1,
    });

    const outcome = await runner.run(agent, { prompt: 'recover' });

    expect(outcome.status).toBe('completed');
    expect(invocations).toBe(2);
    expect(outcome.state.conversation?.items.filter((item) => item.type === 'user')).toHaveLength(
      1,
    );
    await runner.close();
  });
});
