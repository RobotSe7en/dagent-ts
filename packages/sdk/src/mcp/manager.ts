import {
  Client,
  StreamableHTTPClientTransport,
  type Tool as McpTool,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createHash } from 'node:crypto';
import { z } from 'zod';

import type { CapabilityBinding, CapabilityExecutionContext } from '../capabilities/index.js';
import { capability } from '../capabilities/index.js';
import type { JsonValue } from '../contracts/index.js';
import { capabilityIdSchema, jsonValueSchema } from '../contracts/index.js';
import { DagentError, errorMessage } from '../errors.js';
import packageMetadata from '../../package.json' with { type: 'json' };
import type { McpServerConfig } from './config.js';
import { mcpServerConfigSchema } from './config.js';

type ConnectedServer = {
  readonly config: McpServerConfig;
  readonly client: Client;
  readonly capabilities: readonly CapabilityBinding[];
};

function capabilitySegment(value: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(value)) return value;
  const normalized = value
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '');
  const readable = normalized === '' ? 'unnamed' : normalized;
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 8);
  return `${readable}_${digest}`;
}

export function mcpCapabilityId(serverName: string, toolName: string): string {
  return capabilityIdSchema.parse(
    `mcp.${capabilitySegment(serverName)}.${capabilitySegment(toolName)}`,
  );
}

function inputValidator(mcpTool: McpTool): z.ZodType<Record<string, unknown>> {
  try {
    return z.fromJSONSchema(
      mcpTool.inputSchema as Parameters<typeof z.fromJSONSchema>[0],
    ) as z.ZodType<Record<string, unknown>>;
  } catch {
    return z.record(z.string(), z.unknown());
  }
}

function jsonValue(value: unknown): JsonValue | undefined {
  const parsed = jsonValueSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      if (typeof item !== 'object' || item === null) return '';
      const entry = item as Record<string, unknown>;
      if (entry['type'] === 'text' && typeof entry['text'] === 'string') return entry['text'];
      if (entry['type'] === 'resource_link' && typeof entry['uri'] === 'string') {
        return `[resource: ${entry['uri']}]`;
      }
      return '';
    })
    .filter((part) => part !== '')
    .join('\n');
}

function createBinding(
  server: McpServerConfig,
  client: Client,
  mcpTool: McpTool,
): CapabilityBinding {
  const input = inputValidator(mcpTool);
  return capability({
    id: mcpCapabilityId(server.name, mcpTool.name),
    kind: 'mcp',
    name: mcpTool.title ?? mcpTool.name,
    description: mcpTool.description ?? '',
    input,
    output: jsonValueSchema,
    risk: server.risk,
    boundary: {
      network: server.transport === 'http',
      process: server.transport === 'stdio',
    },
    source: `mcp:${server.name}`,
    execute: async (arguments_: Record<string, unknown>, context: CapabilityExecutionContext) => {
      const result = await client.callTool(
        { name: mcpTool.name, arguments: arguments_ },
        { signal: context.signal, timeout: server.toolTimeoutMs },
      );
      const text = contentText(result.content);
      if (result.isError === true) {
        throw new DagentError(
          'CAPABILITY_FAILED',
          text || `MCP tool '${mcpTool.name}' reported an error.`,
        );
      }
      return jsonValue(result.structuredContent) ?? jsonValue(result.content) ?? text;
    },
  });
}

export class McpManager implements AsyncDisposable {
  readonly #servers = new Map<string, ConnectedServer>();

  public async connect(rawConfig: McpServerConfig): Promise<readonly CapabilityBinding[]> {
    const config = mcpServerConfigSchema.parse(rawConfig);
    if (!config.enabled) return [];
    if (this.#servers.has(config.name)) {
      throw new DagentError('INVALID_INPUT', `MCP server '${config.name}' is already connected.`);
    }

    const client = new Client({ name: 'dagent-ai', version: packageMetadata.version });
    try {
      const transport =
        config.transport === 'stdio'
          ? new StdioClientTransport({
              command: config.command,
              args: config.args,
              ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
              ...(config.env === undefined ? {} : { env: config.env }),
              stderr: 'pipe',
            })
          : new StreamableHTTPClientTransport(new URL(config.url), {
              requestInit: { headers: config.headers },
            });
      await client.connect(transport, { timeout: config.connectTimeoutMs });
      const listed = await client.listTools(undefined, { timeout: config.connectTimeoutMs });
      const capabilities = Object.freeze(
        listed.tools
          .filter((mcpTool) => included(config, mcpTool.name))
          .map((mcpTool) => createBinding(config, client, mcpTool)),
      );
      const ids = new Set(capabilities.map(({ definition }) => definition.id));
      if (ids.size !== capabilities.length) {
        throw new DagentError(
          'INVALID_INPUT',
          `MCP server '${config.name}' exposed tools with colliding capability identifiers.`,
        );
      }
      this.#servers.set(config.name, { config, client, capabilities });
      return capabilities;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw new DagentError(
        'MCP_CONNECTION_FAILED',
        `Could not connect to MCP server '${config.name}': ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  public list(): readonly {
    readonly config: McpServerConfig;
    readonly capabilities: readonly CapabilityBinding[];
  }[] {
    return [...this.#servers.values()].map(({ config, capabilities }) => ({
      config,
      capabilities,
    }));
  }

  public async disconnect(name: string): Promise<boolean> {
    const connected = this.#servers.get(name);
    if (connected === undefined) return false;
    this.#servers.delete(name);
    await connected.client.close();
    return true;
  }

  public async close(): Promise<void> {
    const servers = [...this.#servers.values()];
    this.#servers.clear();
    await Promise.allSettled(servers.map(({ client }) => client.close()));
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

function included(config: McpServerConfig, toolName: string): boolean {
  if (config.includeTools !== undefined && !config.includeTools.includes(toolName)) return false;
  return !(config.excludeTools?.includes(toolName) ?? false);
}
