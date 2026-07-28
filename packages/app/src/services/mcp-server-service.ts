import type { AutoAgent, DagAgent, McpServerConfig, Runner, ToolAgent } from 'dagent-ai';
import type { CapabilityDefinition } from 'dagent-ai/contracts';

import type { McpServerRepository, StoredMcpServer } from '../database/mcp-server-repository.js';

export type McpSecretAction = 'preserve' | 'replace' | 'clear';

type PublicMcpConfig =
  | (Omit<Extract<McpServerConfig, { transport: 'stdio' }>, 'env'> & {
      readonly secretNames: readonly string[];
      readonly secretsConfigured: boolean;
    })
  | (Omit<Extract<McpServerConfig, { transport: 'http' }>, 'headers'> & {
      readonly secretNames: readonly string[];
      readonly secretsConfigured: boolean;
    });

export type McpServerPayload = {
  readonly name: string;
  readonly source: 'config' | 'managed';
  readonly editable: boolean;
  readonly deletable: boolean;
  readonly status: 'connected' | 'disabled' | 'error';
  readonly error?: string;
  readonly config: PublicMcpConfig;
  readonly tools: readonly CapabilityDefinition[];
  readonly createdAt?: string;
  readonly updatedAt?: string;
};

type ServerRecord = {
  readonly source: McpServerPayload['source'];
  readonly config: McpServerConfig;
  readonly createdAt?: string;
  readonly updatedAt?: string;
};

export class McpServerServiceError extends Error {
  public constructor(
    public readonly code:
      'MCP_ALREADY_EXISTS' | 'MCP_CONFIG_IMMUTABLE' | 'MCP_IN_USE' | 'MCP_NOT_FOUND',
    message: string,
    public readonly statusCode: 400 | 404 | 409,
  ) {
    super(message);
    this.name = 'McpServerServiceError';
  }
}

export class McpServerService {
  readonly #configured = new Map<string, McpServerConfig>();
  readonly #errors = new Map<string, string>();

  public constructor(
    private readonly runner: Runner,
    private readonly repository: McpServerRepository,
    configuredServers: readonly McpServerConfig[],
  ) {
    for (const config of configuredServers) {
      if (this.#configured.has(config.name)) {
        throw new TypeError(`MCP server '${config.name}' is configured more than once.`);
      }
      this.#configured.set(config.name, config);
    }
  }

  public async initialize(): Promise<void> {
    for (const record of await this.#records()) {
      await this.#connect(record.config);
    }
  }

  public async list(): Promise<{ readonly servers: readonly McpServerPayload[] }> {
    return {
      servers: (await this.#records()).map((record) => this.#payload(record)),
    };
  }

  public async get(name: string): Promise<McpServerPayload> {
    const record = await this.#record(name);
    if (record === undefined) {
      throw new McpServerServiceError('MCP_NOT_FOUND', `MCP server '${name}' was not found.`, 404);
    }
    return this.#payload(record);
  }

  public async create(config: McpServerConfig): Promise<McpServerPayload> {
    if (
      this.#configured.has(config.name) ||
      (await this.repository.get(config.name)) !== undefined
    ) {
      throw new McpServerServiceError(
        'MCP_ALREADY_EXISTS',
        `MCP server '${config.name}' already exists.`,
        409,
      );
    }
    const stored = await this.repository.create(config);
    await this.#connect(stored.config);
    return this.#payload(managedRecord(stored));
  }

  public async update(
    name: string,
    config: McpServerConfig,
    secretAction: McpSecretAction = 'preserve',
  ): Promise<McpServerPayload> {
    if (config.name !== name) {
      throw new McpServerServiceError(
        'MCP_CONFIG_IMMUTABLE',
        `MCP config name '${config.name}' does not match route name '${name}'.`,
        400,
      );
    }
    if (this.#configured.has(name)) {
      throw new McpServerServiceError(
        'MCP_CONFIG_IMMUTABLE',
        'Configured MCP servers are managed through the application config.',
        400,
      );
    }
    const existing = await this.repository.get(name);
    if (existing === undefined) {
      throw new McpServerServiceError('MCP_NOT_FOUND', `MCP server '${name}' was not found.`, 404);
    }
    const resolved = resolveSecrets(config, existing.config, secretAction);
    const stored = await this.repository.update(name, resolved);
    if (stored === undefined) {
      throw new McpServerServiceError('MCP_NOT_FOUND', `MCP server '${name}' was not found.`, 404);
    }
    await this.runner.disconnectMcp(name);
    await this.#connect(stored.config);
    return this.#payload(managedRecord(stored));
  }

  public async delete(name: string): Promise<void> {
    if (this.#configured.has(name)) {
      throw new McpServerServiceError(
        'MCP_CONFIG_IMMUTABLE',
        'Configured MCP servers are managed through the application config.',
        400,
      );
    }
    if ((await this.repository.get(name)) === undefined) {
      throw new McpServerServiceError('MCP_NOT_FOUND', `MCP server '${name}' was not found.`, 404);
    }
    this.#assertUnused(name);
    await this.runner.disconnectMcp(name);
    await this.repository.delete(name);
    this.#errors.delete(name);
  }

  public async reload(): Promise<{ readonly servers: readonly McpServerPayload[] }> {
    const connectedNames = this.runner.mcp.list().map(({ config }) => config.name);
    await Promise.all(connectedNames.map((name) => this.runner.disconnectMcp(name)));
    this.#errors.clear();
    for (const record of await this.#records()) {
      await this.#connect(record.config);
    }
    return this.list();
  }

  async #connect(config: McpServerConfig): Promise<void> {
    this.#errors.delete(config.name);
    if (!config.enabled) return;
    try {
      await this.runner.connectMcp(config);
    } catch (error) {
      this.#errors.set(config.name, error instanceof Error ? error.message : String(error));
    }
  }

  async #records(): Promise<readonly ServerRecord[]> {
    const configured = [...this.#configured.values()].map((config) => ({
      source: 'config' as const,
      config,
    }));
    const managed = (await this.repository.list())
      .filter(({ config }) => !this.#configured.has(config.name))
      .map(managedRecord);
    return [...configured, ...managed].sort((left, right) =>
      left.config.name.localeCompare(right.config.name),
    );
  }

  async #record(name: string): Promise<ServerRecord | undefined> {
    const configured = this.#configured.get(name);
    if (configured !== undefined) return { source: 'config', config: configured };
    const stored = await this.repository.get(name);
    return stored === undefined ? undefined : managedRecord(stored);
  }

  #payload(record: ServerRecord): McpServerPayload {
    const connected = this.runner.mcp
      .list()
      .find(({ config }) => config.name === record.config.name);
    const error = this.#errors.get(record.config.name);
    return {
      name: record.config.name,
      source: record.source,
      editable: record.source === 'managed',
      deletable: record.source === 'managed' && !this.#inUse(record.config.name),
      status: !record.config.enabled ? 'disabled' : connected === undefined ? 'error' : 'connected',
      ...(error === undefined ? {} : { error }),
      config: publicConfig(record.config),
      tools:
        connected?.capabilities.map(
          ({ definition }) => this.runner.catalog.get(definition.id)?.definition ?? definition,
        ) ?? [],
      ...(record.createdAt === undefined ? {} : { createdAt: record.createdAt }),
      ...(record.updatedAt === undefined ? {} : { updatedAt: record.updatedAt }),
    };
  }

  #assertUnused(name: string): void {
    const consumers = this.#consumers(name);
    if (consumers.length === 0) return;
    throw new McpServerServiceError(
      'MCP_IN_USE',
      `MCP server '${name}' is used by agent${consumers.length === 1 ? '' : 's'} ${consumers
        .map((id) => `'${id}'`)
        .join(', ')}.`,
      409,
    );
  }

  #inUse(name: string): boolean {
    return this.#consumers(name).length > 0;
  }

  #consumers(name: string): readonly string[] {
    const capabilityIds = new Set(
      this.runner.mcp
        .list()
        .find(({ config }) => config.name === name)
        ?.capabilities.map(({ definition }) => definition.id) ?? [],
    );
    if (capabilityIds.size === 0) return [];
    return this.runner
      .agents()
      .filter((agent) =>
        agentCapabilityIds(agent).some((capabilityId) => capabilityIds.has(capabilityId)),
      )
      .map((agent) => agent.id);
  }
}

function managedRecord(stored: StoredMcpServer): ServerRecord {
  return {
    source: 'managed',
    config: stored.config,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  };
}

function publicConfig(config: McpServerConfig): PublicMcpConfig {
  if (config.transport === 'stdio') {
    const { env, ...visible } = config;
    const secretNames = Object.keys(env ?? {}).sort();
    return {
      ...visible,
      secretNames,
      secretsConfigured: secretNames.length > 0,
    };
  }
  const { headers, ...visible } = config;
  const secretNames = Object.keys(headers).sort();
  return {
    ...visible,
    secretNames,
    secretsConfigured: secretNames.length > 0,
  };
}

function resolveSecrets(
  next: McpServerConfig,
  existing: McpServerConfig,
  action: McpSecretAction,
): McpServerConfig {
  if (next.transport !== existing.transport || action === 'replace') return next;
  if (next.transport === 'stdio' && existing.transport === 'stdio') {
    if (action === 'clear') {
      const visible = { ...next };
      delete visible.env;
      return visible;
    }
    return { ...next, ...(existing.env === undefined ? {} : { env: existing.env }) };
  }
  if (next.transport === 'http' && existing.transport === 'http') {
    return { ...next, headers: action === 'clear' ? {} : existing.headers };
  }
  return next;
}

function agentCapabilityIds(agent: ToolAgent | DagAgent | AutoAgent): readonly string[] {
  if (agent.kind !== 'auto-agent') return agent.scope.capabilities;
  return [
    ...new Set([
      ...agent.scope.capabilities,
      ...agent.toolAgent.scope.capabilities,
      ...agent.dagAgent.scope.capabilities,
    ]),
  ];
}
