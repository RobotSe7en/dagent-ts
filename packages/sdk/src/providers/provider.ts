import type {
  ChatMessage,
  ChatResponse,
  ChatStreamEvent,
  JsonObject,
  StructuredOutputFormat,
} from '../contracts/index.js';

export type ProviderTool = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
};

export type ChatRequest = {
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ProviderTool[];
  readonly responseFormat?: StructuredOutputFormat;
  readonly metadata?: JsonObject;
};

export interface ChatProvider {
  chat(request: ChatRequest, options?: { readonly signal?: AbortSignal }): Promise<ChatResponse>;

  streamChat(
    request: ChatRequest,
    options?: { readonly signal?: AbortSignal },
  ): AsyncIterable<ChatStreamEvent>;
}
