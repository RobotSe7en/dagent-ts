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
  it('requests compatible structured output, tools, reasoning options, and token usage', async () => {
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
        thinking_token_budget: 512,
        extra_body: {
          temperature: 0,
          thinking: { type: 'enabled' },
        },
        response_format: {
          type: 'json_object',
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
    expect(create).toHaveBeenCalledWith(
      expect.not.objectContaining({ stream_options: expect.anything() }),
      undefined,
    );
  });

  it('opts into streamed usage metadata only when the endpoint supports it', async () => {
    const create = vi.fn().mockResolvedValue(stream([]));
    const provider = providerWith(create, { streamIncludeUsage: true });

    const events: ChatStreamEvent[] = [];
    for await (const event of provider.streamChat(baseRequest)) events.push(event);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: true,
        stream_options: { include_usage: true },
      }),
      undefined,
    );
    expect(events.at(-1)?.type).toBe('done');
  });

  it('merges explicit provider options over generated reasoning defaults', async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: 'done', refusal: null, tool_calls: [] } }],
    });
    const provider = providerWith(create, {
      reasoning: { enabled: true, effort: 'high' },
      extraRequestArgs: { reasoning_effort: 'low', temperature: 0 },
      extraBody: {
        thinking: { type: 'disabled', budget: 512 },
        chat_template_kwargs: { enable_thinking: false },
      },
    });

    await provider.chat(baseRequest);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        reasoning_effort: 'low',
        temperature: 0,
        extra_body: {
          thinking: { type: 'disabled', budget: 512 },
          chat_template_kwargs: { enable_thinking: false },
        },
      }),
      undefined,
    );
  });

  it('rejects invalid or non-object model tool-call arguments', async () => {
    const invalidJson = providerWith(
      vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: '',
              refusal: null,
              tool_calls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'tool.echo', arguments: '{invalid' },
                },
              ],
            },
          },
        ],
      }),
    );
    const nonObject = providerWith(
      vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: '',
              refusal: null,
              tool_calls: [
                {
                  id: 'call-2',
                  type: 'function',
                  function: { name: 'tool.echo', arguments: '[]' },
                },
              ],
            },
          },
        ],
      }),
    );

    await expect(invalidJson.chat(baseRequest)).rejects.toThrow(/not valid JSON/u);
    await expect(nonObject.chat(baseRequest)).rejects.toThrow(/JSON object/u);
  });

  it('strips think tags without retaining them when capture is field-only', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: '<think>discarded</think>visible',
              reasoning_content: 'field',
              refusal: null,
              tool_calls: [],
            },
          },
        ],
      })
      .mockResolvedValueOnce(
        stream([
          {
            choices: [
              {
                delta: {
                  reasoning_content: 'field-stream',
                  content: '<think>discarded-stream</think>visible-stream',
                },
              },
            ],
          },
        ]),
      );
    const provider = providerWith(create, { reasoning: { capture: 'field' } });

    await expect(provider.chat(baseRequest)).resolves.toMatchObject({
      content: 'visible',
      reasoningContent: 'field',
    });
    const events: ChatStreamEvent[] = [];
    for await (const event of provider.streamChat(baseRequest)) events.push(event);

    const tokens = events.filter(
      (event): event is Extract<ChatStreamEvent, { type: 'token' }> => event.type === 'token',
    );
    expect(
      tokens
        .filter((event) => event.channel === 'reasoning')
        .map((event) => event.content)
        .join(''),
    ).toBe('field-stream');
    expect(
      tokens
        .filter((event) => event.channel === 'content')
        .map((event) => event.content)
        .join(''),
    ).toBe('visible-stream');
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      response: {
        content: 'visible-stream',
        reasoningContent: 'field-stream',
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
