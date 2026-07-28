import { afterEach, describe, expect, it, vi } from 'vitest';

import { api, subscribeRun } from './client.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('API client', () => {
  it('unwraps typed resource envelopes from the unified API', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          capabilities: [
            {
              id: 'tool.echo',
              name: 'echo',
              description: '',
              kind: 'tool',
              inputSchema: { type: 'object' },
              outputSchema: {},
              risk: 'low',
              boundary: {},
              enabled: true,
              source: 'test',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          skills: [
            {
              name: 'review',
              qualifiedName: 'review',
              description: 'Review.',
              managed: true,
            },
          ],
        }),
      );
    vi.stubGlobal('fetch', fetch);

    await expect(api.capabilities()).resolves.toEqual([
      expect.objectContaining({ id: 'tool.echo' }),
    ]);
    await expect(api.skills()).resolves.toEqual([
      expect.objectContaining({ qualifiedName: 'review' }),
    ]);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/capabilities',
      '/api/v1/skills',
    ]);
  });

  it('uses PATCH for capability state and the managed MCP server routes', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse({ capability: { id: 'tool.echo' } }))
      .mockResolvedValueOnce(jsonResponse({ server: { name: 'docs' } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);

    await api.setCapabilityEnabled('tool.echo', false);
    await api.connectMcp({
      name: 'docs',
      transport: 'http',
      url: 'https://mcp.example.test',
    });
    await api.disconnectMcp('docs');

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      '/api/v1/capabilities/tool.echo',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ enabled: false }),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      '/api/v1/mcp/servers',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      '/api/v1/mcp/servers/docs',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('surfaces structured application errors instead of response parsing noise', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(
          jsonResponse({ error: { code: 'INVALID_INPUT', message: 'The DAG is invalid.' } }, 400),
        ),
    );

    await expect(api.validateDag({})).rejects.toMatchObject({
      message: 'The DAG is invalid.',
      status: 400,
    });
  });

  it('subscribes to named run events and closes the EventSource', () => {
    const instances: FakeEventSource[] = [];
    vi.stubGlobal(
      'EventSource',
      class extends FakeEventSource {
        public constructor(url: string) {
          super(url);
          instances.push(this);
        }
      },
    );
    const listener = vi.fn();
    const onError = vi.fn();

    const unsubscribe = subscribeRun('run-1' as never, listener, onError);
    const source = instances[0];
    source?.emit('run-started', {
      type: 'run-started',
      runId: 'run-1',
      sequence: 1,
      timestamp: new Date().toISOString(),
    });
    source?.fail();
    unsubscribe();

    expect(source?.url).toBe('/api/v1/runs/run-1/events');
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'run-started', sequence: 1 }),
    );
    expect(onError).toHaveBeenCalledOnce();
    expect(source?.closed).toBe(true);
  });
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

class FakeEventSource {
  public onerror: ((event: Event) => void) | null = null;
  public closed = false;
  readonly #listeners = new Map<string, (event: MessageEvent<string>) => void>();

  public constructor(public readonly url: string) {}

  public addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.#listeners.set(type, listener as (event: MessageEvent<string>) => void);
  }

  public emit(type: string, value: unknown): void {
    this.#listeners.get(type)?.({ data: JSON.stringify(value) } as MessageEvent<string>);
  }

  public fail(): void {
    this.onerror?.({ type: 'error' } as Event);
  }

  public close(): void {
    this.closed = true;
  }
}
