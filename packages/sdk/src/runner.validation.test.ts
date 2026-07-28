import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { tool } from './capabilities/tool.js';
import { defineToolAgent } from './contracts/agents.js';
import type { ChatResponse } from './contracts/messages.js';
import { createAgentProfile } from './profiles/profile.js';
import { Runner } from './runner.js';
import { MockProvider } from './testing/mock-provider.js';

describe('Runner result validation', () => {
  it('retries internally without exposing the rejected draft or validator feedback', async () => {
    const echo = tool({
      id: 'tool.echo',
      input: z.object({ text: z.string() }).strict(),
      output: z.string(),
      execute: ({ text }) => text,
    });
    const provider = new MockProvider([
      reply('', [{ id: 'call-1', name: 'tool.echo', arguments: { text: 'evidence' } }]),
      reply('first incomplete answer'),
      reply(
        JSON.stringify({
          passed: false,
          issues: [{ message: 'Include the capability evidence.' }],
          summary: 'Incomplete.',
        }),
      ),
      reply('corrected answer with evidence'),
      reply('{"passed":true,"issues":[],"summary":"Complete."}'),
    ]);
    const runner = new Runner({
      provider,
      capabilities: [echo],
      validation: {
        enabled: true,
        maxRetries: 1,
        profile: createAgentProfile({ name: 'validator', content: 'Validate the result.' }),
      },
    });
    const agent = defineToolAgent({
      kind: 'tool-agent',
      id: 'assistant',
      name: 'Assistant',
      systemPrompt: 'Help.',
      scope: { capabilities: ['tool.echo'] },
      reviewLevel: 'never',
    });

    const outcome = await runner.run(agent, { prompt: 'Use evidence.' });

    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') {
      throw new Error(`Unexpected status: ${outcome.status}`);
    }
    expect(outcome.state.validations.map(({ result }) => result.passed)).toEqual([false, true]);
    expect(
      outcome.state.conversation?.items.filter(({ visibility }) => visibility === 'user'),
    ).toMatchObject([
      { type: 'user', content: 'Use evidence.', visibility: 'user' },
      { type: 'assistant', content: 'corrected answer with evidence', visibility: 'user' },
    ]);
    expect(
      outcome.state.conversation?.items.some(
        (item) =>
          item.type === 'assistant' &&
          item.content === 'first incomplete answer' &&
          item.visibility === 'internal',
      ),
    ).toBe(true);
    expect(
      outcome.state.conversation?.items.some(
        (item) =>
          item.type === 'user' &&
          item.scope === 'validator' &&
          item.visibility === 'internal' &&
          item.content.includes('Include the capability evidence.'),
      ),
    ).toBe(true);
    expect(outcome.checkpoint.usage.modelCalls).toBe(5);
    await runner.close();
  });

  it('records a failed validation when retry budget is zero', async () => {
    const inspect = tool({
      id: 'tool.inspect',
      input: z.object({}).strict(),
      output: z.literal('evidence'),
      execute: () => 'evidence' as const,
    });
    const provider = new MockProvider([
      reply('', [{ id: 'call-1', name: 'tool.inspect', arguments: {} }]),
      reply('draft'),
      reply('{"passed":false,"issues":[{"message":"Incomplete."}],"summary":"Retry."}'),
    ]);
    const runner = new Runner({
      provider,
      capabilities: [inspect],
      validation: {
        enabled: true,
        maxRetries: 0,
        profile: createAgentProfile({ name: 'validator', content: 'Validate.' }),
      },
    });
    const agent = defineToolAgent({
      kind: 'tool-agent',
      id: 'assistant',
      name: 'Assistant',
      scope: { capabilities: ['tool.inspect'] },
      reviewLevel: 'never',
    });

    const outcome = await runner.run(agent, { prompt: 'Inspect.' });

    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') {
      throw new Error(`Unexpected status: ${outcome.status}`);
    }
    expect(outcome.state.validations).toHaveLength(1);
    expect(outcome.state.validations[0]?.result.passed).toBe(false);
    expect(outcome.output).toBe('draft');
    await runner.close();
  });

  it('does not validate direct answers that have no execution context', async () => {
    const provider = new MockProvider([reply('direct answer')]);
    const runner = new Runner({
      provider,
      validation: {
        enabled: true,
        profile: createAgentProfile({ name: 'validator', content: 'Validate.' }),
      },
    });
    const agent = defineToolAgent({
      kind: 'tool-agent',
      id: 'assistant',
      name: 'Assistant',
      scope: { capabilities: [] },
      reviewLevel: 'never',
    });

    const outcome = await runner.run(agent, { prompt: 'Answer directly.' });

    expect(outcome.status).toBe('completed');
    expect(outcome.state.validations).toEqual([]);
    expect(provider.requests).toHaveLength(1);
    await runner.close();
  });
});

function reply(content: string, toolCalls: ChatResponse['toolCalls'] = []): ChatResponse {
  return {
    content,
    reasoningContent: '',
    refusal: '',
    toolCalls,
  };
}
