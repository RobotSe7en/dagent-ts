import type { ChatResponse, ChatStreamEvent } from '../contracts/index.js';
import { DagentError } from '../errors.js';
import type { ChatProvider, ChatRequest } from '../providers/provider.js';

export type MockProviderReply =
  ChatResponse | ((request: ChatRequest) => ChatResponse | Promise<ChatResponse>);

export class MockProvider implements ChatProvider {
  readonly #replies: MockProviderReply[];
  public readonly requests: ChatRequest[] = [];

  public constructor(replies: readonly MockProviderReply[]) {
    this.#replies = [...replies];
  }

  public async chat(request: ChatRequest): Promise<ChatResponse> {
    this.requests.push(request);
    const reply = this.#replies.shift();
    if (reply === undefined) {
      throw new DagentError('PROVIDER_FAILED', 'MockProvider has no queued reply.');
    }
    return typeof reply === 'function' ? reply(request) : reply;
  }

  public async *streamChat(request: ChatRequest): AsyncIterable<ChatStreamEvent> {
    const response = await this.chat(request);
    if (response.reasoningContent.length > 0) {
      yield { type: 'token', channel: 'reasoning', content: response.reasoningContent };
    }
    if (response.content.length > 0) {
      yield { type: 'token', channel: 'content', content: response.content };
    }
    yield { type: 'done', response };
  }
}
