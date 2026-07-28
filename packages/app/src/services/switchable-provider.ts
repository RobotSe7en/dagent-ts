import type { ChatProvider, ChatRequest } from 'dagent-ai';
import type { ChatResponse, ChatStreamEvent } from 'dagent-ai/contracts';

export class SwitchableProvider implements ChatProvider {
  #active: { readonly id: string; readonly provider: ChatProvider };

  public constructor(id: string, provider: ChatProvider) {
    this.#active = { id, provider };
  }

  public get activeId(): string {
    return this.#active.id;
  }

  public get contextWindowTokens(): number | undefined {
    return providerNumber(this.#active.provider, 'contextWindowTokens');
  }

  public get outputReserveTokens(): number | undefined {
    return providerNumber(this.#active.provider, 'outputReserveTokens');
  }

  public use(id: string, provider: ChatProvider): void {
    this.#active = { id, provider };
  }

  public chat(
    request: ChatRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ChatResponse> {
    const provider = this.#active.provider;
    return provider.chat(request, options);
  }

  public streamChat(
    request: ChatRequest,
    options?: { readonly signal?: AbortSignal },
  ): AsyncIterable<ChatStreamEvent> {
    const provider = this.#active.provider;
    return provider.streamChat(request, options);
  }
}

function providerNumber(provider: ChatProvider, key: string): number | undefined {
  const value = (provider as unknown as Readonly<Record<string, unknown>>)[key];
  return typeof value === 'number' ? value : undefined;
}
