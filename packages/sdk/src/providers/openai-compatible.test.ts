import { describe, expect, it, vi } from 'vitest';

import type { ChatStreamEvent } from '../contracts/index.js';
import type { ChatRequest } from './provider.js';
import {
  OpenAICompatibleProvider,
  type OpenAICompatibleProviderOptions,
} from './openai-compatible.js';

const baseRequest: ChatRequest = {
  messages: [{ role: 'user', content: 'hello' }],
};

describe('OpenAICompatibleProvider', () => {
  it('forwards strict JSON Schema, tools, reasoning options, and token usage', async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: '<think>checking</think>{"answer":42}',
            refusal: null,
            tool_calls: [],
          },
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        completion_tokens_details: { reasoning_tokens: 2 },
      },
    });
    const provider = providerWith(create, {
      reasoning: { enabled: true, effort: 'medium', budgetTokens: 512 },
      extraBody: { temperature: 0 },
    });

    const response = await provider.chat({
      ...baseRequest,
      tools: [
        {
          name: 'tool.echo',
          description: 'Echo text.',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
          },
        },
      ],
      responseFormat: {
        name: 'answer',
        description: 'Typed answer.',
        schema: {
          type: 'object',
          properties: { answer: { type: 'number' } },
          required: ['answer'],
        },
        strict: true,
      },
    });

    expect(response).toMatchObject({
      content: '{"answer":42}',
      reasoningContent: 'checking',
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 2,
        totalTokens: 15,
      },
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: false,
        reasoning_effort: 'medium',
        extra_body: {
          temperature: 0,
          thinking: { type: 'enabled' },
          thinking_token_budget: 512,
        },
        response_format: {
          type: 'json_schema',
          json_schema: expect.objectContaining({
            name: 'answer',
            strict: true,
          }),
        },
        tools: [
          expect.objectContaining({
            type: 'function',
            function: expect.objectContaining({ name: 'tool.echo' }),
          }),
        ],
      }),
      undefined,
    );
  });

  it('reconstructs streamed tool calls and separates reasoning channels', async () => {
    const create = vi.fn().mockResolvedValue(
      stream([
        {
          choices: [
            {
              delta: {
                reasoning_content: 'field ',
                content: '<thi',
                tool_calls: [
                  {
                    index: 0,
                    id: 'call-',
                    function: { name: 'tool.', arguments: '{"text":' },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                content: 'nk>tagged</think>visible',
                tool_calls: [
                  {
                    index: 0,
                    id: '1',
                    function: { name: 'echo', arguments: '"hi"}' },
                  },
                ],
              },
            },
          ],
          usage: {
            prompt_tokens: 4,
            completion_tokens: 6,
            total_tokens: 10,
          },
        },
      ]),
    );
    const provider = providerWith(create);

    const events: ChatStreamEvent[] = [];
    for await (const event of provider.streamChat(baseRequest)) events.push(event);

    const tokens = events.filter(
      (event): event is Extract<(typeof events)[number], { type: 'token' }> =>
        event.type === 'token',
    );
    expect(
      tokens
        .filter(({ channel }) => channel === 'reasoning')
        .map(({ content }) => content)
        .join(''),
    ).toBe('field tagged');
    expect(
      tokens
        .filter(({ channel }) => channel === 'content')
        .map(({ content }) => content)
        .join(''),
    ).toBe('visible');
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      response: {
        content: 'visible',
        reasoningContent: 'field tagged',
        toolCalls: [
          {
            id: 'call-1',
            name: 'tool.echo',
            arguments: { text: 'hi' },
          },
        ],
      },
    });
  });

  it('validates context and output reserve limits', () => {
    expect(() =>
      providerWith(vi.fn(), {
        contextWindowTokens: 1024,
        outputReserveTokens: 1024,
      }),
    ).toThrow(/outputReserveTokens/u);
  });
});

function providerWith(
  create: ReturnType<typeof vi.fn>,
  options: Partial<OpenAICompatibleProviderOptions> = {},
): OpenAICompatibleProvider {
  const client = {
    chat: { completions: { create } },
  } as unknown as NonNullable<OpenAICompatibleProviderOptions['client']>;
  return new OpenAICompatibleProvider({
    baseURL: 'https://provider.example.test/v1',
    model: 'test-model',
    client,
    ...options,
  });
}

async function* stream(values: readonly unknown[]) {
  for (const value of values) yield value;
}
