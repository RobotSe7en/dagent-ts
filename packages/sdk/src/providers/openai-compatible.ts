import OpenAI from 'openai';

import type {
  ChatMessage,
  ChatResponse,
  ChatStreamEvent,
  JsonObject,
  ModelTokenUsage,
  ProviderToolCall,
} from '../contracts/index.js';
import { chatResponseSchema, jsonObjectSchema, modelTokenUsageSchema } from '../contracts/index.js';
import { DagentError, errorMessage } from '../errors.js';
import type { ChatProvider, ChatRequest } from './provider.js';
import { ThinkingStreamParser } from './thinking-parser.js';

export type ReasoningOptions = {
  readonly enabled?: boolean | undefined;
  readonly effort?: OpenAI.Chat.Completions.ChatCompletionReasoningEffort | undefined;
  readonly budgetTokens?: number | undefined;
  readonly capture?: 'field' | 'field-and-tags' | undefined;
};

export type OpenAICompatibleProviderOptions = {
  readonly baseURL: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly apiKeyEnv?: string;
  readonly timeoutMs?: number;
  readonly reasoning?: ReasoningOptions;
  readonly streamIncludeUsage?: boolean;
  readonly contextWindowTokens?: number;
  readonly outputReserveTokens?: number;
  readonly extraRequestArgs?: JsonObject;
  readonly extraBody?: JsonObject;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  readonly client?: OpenAI;
};

export class OpenAICompatibleProvider implements ChatProvider {
  public readonly contextWindowTokens: number;
  public readonly outputReserveTokens: number;
  readonly #client: OpenAI;
  readonly #options: OpenAICompatibleProviderOptions;

  public constructor(options: OpenAICompatibleProviderOptions) {
    this.#options = options;
    this.contextWindowTokens = options.contextWindowTokens ?? 32_768;
    this.outputReserveTokens = options.outputReserveTokens ?? 4096;
    if (this.outputReserveTokens < 0 || this.outputReserveTokens >= this.contextWindowTokens) {
      throw new TypeError(
        'outputReserveTokens must be non-negative and smaller than contextWindowTokens.',
      );
    }
    const apiKey =
      options.apiKey ??
      (options.apiKeyEnv === undefined ? undefined : process.env[options.apiKeyEnv]) ??
      'not-needed';
    this.#client =
      options.client ??
      new OpenAI({
        apiKey,
        baseURL: options.baseURL,
        timeout: options.timeoutMs ?? 60_000,
        ...(options.defaultHeaders === undefined
          ? {}
          : { defaultHeaders: { ...options.defaultHeaders } }),
      });
  }

  public async chat(
    request: ChatRequest,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<ChatResponse> {
    try {
      const response = await this.#client.chat.completions.create(
        this.#nonStreamingRequest(request),
        options.signal === undefined ? undefined : { signal: options.signal },
      );
      const message = response.choices[0]?.message;
      if (message === undefined) {
        throw new DagentError('PROVIDER_FAILED', 'The provider returned no completion choice.');
      }
      const captured = captureResponseContent(
        message.content ?? '',
        readStringProperty(message, 'reasoning_content', 'reasoning'),
        this.#captureTags,
      );
      return chatResponseSchema.parse({
        content: captured.content,
        reasoningContent: captured.reasoning,
        refusal: message.refusal ?? '',
        toolCalls: message.tool_calls
          ?.filter(
            (call): call is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall =>
              call.type === 'function',
          )
          .map((call) => ({
            id: call.id,
            name: call.function.name,
            arguments: parseToolArguments(call.function.arguments),
          })),
        usage: modelUsage(response.usage),
      });
    } catch (error) {
      if (error instanceof DagentError) throw error;
      throw new DagentError('PROVIDER_FAILED', errorMessage(error), { cause: error });
    }
  }

  public async *streamChat(
    request: ChatRequest,
    options: { readonly signal?: AbortSignal } = {},
  ): AsyncIterable<ChatStreamEvent> {
    try {
      const stream = await this.#client.chat.completions.create(
        this.#streamingRequest(request),
        options.signal === undefined ? undefined : { signal: options.signal },
      );
      const parser = new ThinkingStreamParser();
      let content = '';
      let reasoningContent = '';
      let refusal = '';
      let usage: ModelTokenUsage | undefined;
      const calls = new Map<number, { id: string; name: string; arguments: string }>();

      for await (const chunk of stream) {
        const chunkUsage = modelUsage(chunk.usage);
        if (chunkUsage !== undefined) usage = chunkUsage;
        const delta = chunk.choices[0]?.delta;
        if (delta === undefined) continue;
        const reasoning = readStringProperty(delta, 'reasoning_content', 'reasoning');
        if (reasoning.length > 0) {
          reasoningContent += reasoning;
          yield { type: 'token', channel: 'reasoning', content: reasoning };
        }
        if (delta.content !== null && delta.content !== undefined && delta.content.length > 0) {
          for (const part of parser.feed(delta.content)) {
            if (part.channel === 'reasoning') {
              if (this.#captureTags) {
                reasoningContent += part.content;
                if (part.content.length > 0) yield { type: 'token', ...part };
              }
            } else {
              content += part.content;
              if (part.content.length > 0) yield { type: 'token', ...part };
            }
          }
        }
        refusal += readStringProperty(delta, 'refusal');
        for (const call of delta.tool_calls ?? []) {
          const current = calls.get(call.index) ?? { id: '', name: '', arguments: '' };
          current.id += call.id ?? '';
          current.name += call.function?.name ?? '';
          current.arguments += call.function?.arguments ?? '';
          calls.set(call.index, current);
        }
      }

      for (const part of parser.finish()) {
        if (part.channel === 'reasoning') {
          if (this.#captureTags) {
            reasoningContent += part.content;
            if (part.content.length > 0) yield { type: 'token', ...part };
          }
        } else {
          content += part.content;
          if (part.content.length > 0) yield { type: 'token', ...part };
        }
      }
      const toolCalls: ProviderToolCall[] = [...calls.entries()]
        .sort(([left], [right]) => left - right)
        .filter(([, call]) => call.name.length > 0)
        .map(([, call]) => ({
          id: call.id || crypto.randomUUID(),
          name: call.name,
          arguments: parseToolArguments(call.arguments),
        }));
      yield {
        type: 'done',
        response: chatResponseSchema.parse({
          content,
          reasoningContent,
          refusal,
          toolCalls,
          ...(usage === undefined ? {} : { usage }),
        }),
      };
    } catch (error) {
      throw new DagentError('PROVIDER_FAILED', errorMessage(error), { cause: error });
    }
  }

  get #captureTags(): boolean {
    return (this.#options.reasoning?.capture ?? 'field-and-tags') === 'field-and-tags';
  }

  #nonStreamingRequest(
    request: ChatRequest,
  ): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming {
    return {
      ...this.#requestBase(request),
      stream: false,
    } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
  }

  #streamingRequest(
    request: ChatRequest,
  ): OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming {
    return {
      ...this.#requestBase(request),
      stream: true,
      ...(this.#options.streamIncludeUsage === true
        ? { stream_options: { include_usage: true } }
        : {}),
    } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
  }

  #requestBase(request: ChatRequest): Readonly<Record<string, unknown>> {
    const reasoning = this.#options.reasoning;
    let extraBody: JsonObject = {};
    if (reasoning?.enabled !== undefined) {
      extraBody = { thinking: { type: reasoning.enabled ? 'enabled' : 'disabled' } };
    }
    extraBody = mergeJsonObjects(extraBody, this.#options.extraBody ?? {});
    return {
      model: this.#options.model,
      messages: request.messages.map(toOpenAIMessage),
      ...(request.tools === undefined || request.tools.length === 0
        ? {}
        : {
            tools: request.tools.map((tool) => ({
              type: 'function' as const,
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
              },
            })),
          }),
      ...(reasoning?.effort === undefined ? {} : { reasoning_effort: reasoning.effort }),
      ...(reasoning?.budgetTokens === undefined
        ? {}
        : { thinking_token_budget: reasoning.budgetTokens }),
      ...(Object.keys(extraBody).length === 0 ? {} : { extra_body: extraBody }),
      ...this.#options.extraRequestArgs,
      ...(request.responseFormat === undefined
        ? {}
        : { response_format: { type: 'json_object' as const } }),
    };
  }
}

function toOpenAIMessage(message: ChatMessage): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      content: message.content,
      tool_call_id: message.toolCallId ?? '',
    };
  }
  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      content: message.content,
      ...(message.toolCalls === undefined
        ? {}
        : {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: 'function' as const,
              function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            })),
          }),
    };
  }
  return {
    role: message.role,
    content: message.content,
    ...(message.name === undefined ? {} : { name: message.name }),
  };
}

function parseToolArguments(value: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value || '{}') as unknown;
  } catch {
    throw new DagentError('PROVIDER_FAILED', 'Model tool-call arguments are not valid JSON.');
  }
  const result = jsonObjectSchema.safeParse(parsed);
  if (!result.success) {
    throw new DagentError(
      'PROVIDER_FAILED',
      'Model tool-call arguments must decode to a JSON object.',
    );
  }
  return result.data;
}

function readStringProperty(value: object, ...keys: readonly string[]): string {
  const record = value as Readonly<Record<string, unknown>>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === 'string') return candidate;
  }
  return '';
}

function captureResponseContent(
  content: string,
  reasoning: string,
  captureTags: boolean,
): { readonly content: string; readonly reasoning: string } {
  if (!content.includes('<think>')) return { content, reasoning };
  const parser = new ThinkingStreamParser(true);
  let visible = '';
  let capturedReasoning = reasoning;
  for (const part of [...parser.feed(content), ...parser.finish()]) {
    if (part.channel === 'reasoning') {
      if (captureTags) capturedReasoning += part.content;
    } else visible += part.content;
  }
  return { content: visible.trim(), reasoning: capturedReasoning };
}

function mergeJsonObjects(base: JsonObject, override: JsonObject): JsonObject {
  const merged: Record<string, JsonObject[string]> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = merged[key];
    merged[key] =
      isJsonObject(current) && isJsonObject(value) ? mergeJsonObjects(current, value) : value;
  }
  return merged;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function modelUsage(value: unknown): ModelTokenUsage | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const usage = value as Readonly<Record<string, unknown>>;
  const details = readRecord(usage['completion_tokens_details'] ?? usage['output_tokens_details']);
  const inputTokens = readNumber(usage['prompt_tokens'] ?? usage['input_tokens']);
  const outputTokens = readNumber(usage['completion_tokens'] ?? usage['output_tokens']);
  const totalTokens = Math.max(inputTokens + outputTokens, readNumber(usage['total_tokens']));
  return modelTokenUsageSchema.parse({
    inputTokens,
    outputTokens,
    reasoningTokens: readNumber(details['reasoning_tokens']),
    totalTokens,
  });
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object'
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}
