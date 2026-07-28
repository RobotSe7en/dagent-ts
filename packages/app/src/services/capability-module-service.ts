import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

import { Workspace, discoverCapabilityModuleExports, loadCapabilityModule } from 'dagent-ai';
import type { AutoAgent, CapabilityModuleExport, DagAgent, Runner, ToolAgent } from 'dagent-ai';
import type { CapabilityBinding } from 'dagent-ai/capabilities';
import type { CapabilityDefinition } from 'dagent-ai/contracts';

import type { AppConfig } from '../config.js';
import type {
  CapabilityModuleConfig,
  CapabilityModuleRepository,
  StoredCapabilityModule,
} from '../database/capability-module-repository.js';

const sourceExtensions = new Set(['.js', '.mjs', '.ts', '.mts']);
const maxSourceBytes = 1024 * 1024;

type ModuleRecord = {
  readonly source: 'config' | 'path' | 'managed';
  readonly config: Omit<CapabilityModuleConfig, 'source'>;
  readonly createdAt?: string;
  readonly updatedAt?: string;
};

export type CapabilityModulePayload = {
  readonly id: string;
  readonly source: ModuleRecord['source'];
  readonly editable: boolean;
  readonly deletable: boolean;
  readonly status: 'active' | 'disabled' | 'error';
  readonly path: string;
  readonly exports: readonly string[];
  readonly enabled: boolean;
  readonly error?: string;
  readonly capabilities: readonly CapabilityDefinition[];
  readonly createdAt?: string;
  readonly updatedAt?: string;
};

export class CapabilityModuleServiceError extends Error {
  public constructor(
    public readonly code:
      | 'MODULE_ALREADY_EXISTS'
      | 'MODULE_CONFIG_IMMUTABLE'
      | 'MODULE_IN_USE'
      | 'MODULE_INVALID'
      | 'MODULE_NOT_FOUND',
    message: string,
    public readonly statusCode: 400 | 404 | 409,
  ) {
    super(message);
    this.name = 'CapabilityModuleServiceError';
  }
}

export class CapabilityModuleService {
  readonly #configured = new Map<string, ModuleRecord>();
  readonly #errors = new Map<string, string>();
  readonly #bindings = new Map<string, readonly CapabilityBinding[]>();
  #workspace: Workspace | undefined;

  public constructor(
    private readonly runner: Runner,
    private readonly repository: CapabilityModuleRepository,
    configuredModules: AppConfig['capabilityModules'],
    private readonly managedRoot: string,
  ) {
    for (const config of configuredModules) {
      if (this.#configured.has(config.id)) {
        throw new TypeError(`Capability module '${config.id}' is configured more than once.`);
      }
      this.#configured.set(config.id, {
        source: 'config',
        config: {
          id: config.id,
          path: config.path,
          exports: config.exports,
          enabled: config.enabled,
        },
      });
    }
  }

  public async initialize(): Promise<void> {
    this.#workspace = await Workspace.open(this.managedRoot);
    for (const record of await this.#records()) await this.#activate(record, false);
  }

  public async list(): Promise<{ readonly modules: readonly CapabilityModulePayload[] }> {
    return { modules: (await this.#records()).map((record) => this.#payload(record)) };
  }

  public async get(id: string): Promise<CapabilityModulePayload> {
    return this.#payload(await this.#requireRecord(id));
  }

  public async createPath(config: CapabilityModuleConfig): Promise<CapabilityModulePayload> {
    await this.#assertAvailable(config.id);
    if (config.source !== 'path') {
      throw new CapabilityModuleServiceError(
        'MODULE_INVALID',
        'Path module creation requires source "path".',
        400,
      );
    }
    const stored = await this.repository.create({
      ...config,
      path: resolve(config.path),
    });
    const record = storedRecord(stored);
    await this.#activate(record);
    return this.#payload(record);
  }

  public async upload(input: {
    readonly id: string;
    readonly filename: string;
    readonly content: string;
    readonly exports: readonly string[];
    readonly enabled: boolean;
  }): Promise<CapabilityModulePayload> {
    await this.#assertAvailable(input.id);
    const extension = validateExtension(input.filename);
    const relativePath = `${input.id}${extension}`;
    const workspace = this.#requireWorkspace();
    await workspace.writeFile(relativePath, input.content, { overwrite: false });
    const config: CapabilityModuleConfig = {
      id: input.id,
      source: 'managed',
      path: relativePath,
      exports: input.exports,
      enabled: input.enabled,
    };
    try {
      if (input.enabled) {
        const bindings = await this.#load(storedRecordPreview(config));
        this.#assertRegisterable(input.id, bindings);
      }
      const stored = await this.repository.create(config);
      const record = storedRecord(stored);
      await this.#activate(record);
      return this.#payload(record);
    } catch (error) {
      await workspace.deleteFile(relativePath, { missingOk: true });
      throw error;
    }
  }

  public async update(
    id: string,
    config: CapabilityModuleConfig,
  ): Promise<CapabilityModulePayload> {
    if (config.id !== id) {
      throw new CapabilityModuleServiceError(
        'MODULE_CONFIG_IMMUTABLE',
        `Capability module id '${config.id}' does not match route id '${id}'.`,
        400,
      );
    }
    if (this.#configured.has(id)) {
      throw new CapabilityModuleServiceError(
        'MODULE_CONFIG_IMMUTABLE',
        'Configured capability modules are managed through the application config.',
        400,
      );
    }
    const existing = await this.repository.get(id);
    if (existing === undefined) {
      throw new CapabilityModuleServiceError(
        'MODULE_NOT_FOUND',
        `Capability module '${id}' was not found.`,
        404,
      );
    }
    if (
      existing.config.source === 'managed' &&
      (config.source !== 'managed' || config.path !== existing.config.path)
    ) {
      throw new CapabilityModuleServiceError(
        'MODULE_CONFIG_IMMUTABLE',
        'Managed capability module paths cannot be changed.',
        400,
      );
    }
    const normalized =
      config.source === 'path' ? { ...config, path: resolve(config.path) } : config;
    if (normalized.enabled) {
      const bindings = await this.#load(storedRecordPreview(normalized));
      this.#assertRegisterable(id, bindings);
      this.#assertCapabilitiesUnused(id, bindings);
    } else {
      this.#assertCapabilitiesUnused(id, []);
    }
    const stored = await this.repository.update(id, normalized);
    if (stored === undefined) {
      throw new CapabilityModuleServiceError(
        'MODULE_NOT_FOUND',
        `Capability module '${id}' was not found.`,
        404,
      );
    }
    const record = storedRecord(stored);
    await this.#activate(record);
    return this.#payload(record);
  }

  public async replaceManagedSource(id: string, content: string): Promise<CapabilityModulePayload> {
    const stored = await this.repository.get(id);
    if (stored === undefined) {
      throw new CapabilityModuleServiceError(
        'MODULE_NOT_FOUND',
        `Capability module '${id}' was not found.`,
        404,
      );
    }
    if (stored.config.source !== 'managed') {
      throw new CapabilityModuleServiceError(
        'MODULE_CONFIG_IMMUTABLE',
        'Only uploaded capability module source can be replaced.',
        400,
      );
    }
    const workspace = this.#requireWorkspace();
    const previous = await readFile(await workspace.resolveExisting(stored.config.path), 'utf8');
    await workspace.writeFile(stored.config.path, content);
    const record = storedRecord(stored);
    try {
      if (stored.config.enabled) {
        const bindings = await this.#load(record);
        this.#assertRegisterable(id, bindings);
        this.#assertCapabilitiesUnused(id, bindings);
      }
      await this.#activate(record);
      return this.#payload(record);
    } catch (error) {
      await workspace.writeFile(stored.config.path, previous);
      throw error;
    }
  }

  public async source(id: string): Promise<{ readonly content: string; readonly path: string }> {
    const record = await this.#requireRecord(id);
    const path = await this.#path(record);
    const information = await stat(path);
    if (!information.isFile() || information.size > maxSourceBytes) {
      throw new CapabilityModuleServiceError(
        'MODULE_INVALID',
        `Capability module source must be a regular file no larger than ${maxSourceBytes} bytes.`,
        400,
      );
    }
    return { content: await readFile(path, 'utf8'), path: record.config.path };
  }

  public async discoverPath(path: string): Promise<readonly CapabilityModuleExport[]> {
    return discoverCapabilityModuleExports(resolve(path));
  }

  public async discoverContent(
    content: string,
    extensionValue: string,
  ): Promise<readonly CapabilityModuleExport[]> {
    const extension = validateExtension(`module${extensionValue}`);
    const temporaryPath = `.discover-${randomUUID()}${extension}`;
    const workspace = this.#requireWorkspace();
    await workspace.writeFile(temporaryPath, content, { overwrite: false });
    try {
      return await discoverCapabilityModuleExports(
        await workspace.resolveExisting(temporaryPath),
        workspace.root,
      );
    } finally {
      await workspace.deleteFile(temporaryPath, { missingOk: true });
    }
  }

  public async validate(config: CapabilityModuleConfig): Promise<{
    readonly capabilities: readonly CapabilityDefinition[];
  }> {
    const record = storedRecordPreview(
      config.source === 'path' ? { ...config, path: resolve(config.path) } : config,
    );
    const bindings = config.enabled ? await this.#load(record) : [];
    this.#assertRegisterable(config.id, bindings);
    return { capabilities: bindings.map(({ definition }) => definition) };
  }

  public async reload(): Promise<{ readonly modules: readonly CapabilityModulePayload[] }> {
    for (const record of await this.#records()) await this.#activate(record);
    return this.list();
  }

  public async delete(id: string): Promise<void> {
    if (this.#configured.has(id)) {
      throw new CapabilityModuleServiceError(
        'MODULE_CONFIG_IMMUTABLE',
        'Configured capability modules are managed through the application config.',
        400,
      );
    }
    const stored = await this.repository.get(id);
    if (stored === undefined) {
      throw new CapabilityModuleServiceError(
        'MODULE_NOT_FOUND',
        `Capability module '${id}' was not found.`,
        404,
      );
    }
    this.#assertCapabilitiesUnused(id, []);
    this.#unregister(id);
    await this.repository.delete(id);
    this.#errors.delete(id);
    if (stored.config.source === 'managed') {
      await this.#requireWorkspace().deleteFile(stored.config.path, { missingOk: true });
    }
  }

  async #activate(record: ModuleRecord, enforceUsage = true): Promise<void> {
    const id = record.config.id;
    this.#errors.delete(id);
    if (!record.config.enabled) {
      if (enforceUsage) this.#assertCapabilitiesUnused(id, []);
      this.#unregister(id);
      return;
    }
    try {
      const bindings = await this.#load(record);
      this.#assertRegisterable(id, bindings);
      if (enforceUsage) this.#assertCapabilitiesUnused(id, bindings);
      const previous = this.#bindings.get(id) ?? [];
      this.#unregister(id);
      try {
        for (const binding of bindings) this.runner.catalog.register(binding);
        this.#bindings.set(id, bindings);
      } catch (error) {
        for (const binding of bindings) this.runner.catalog.unregister(binding.definition.id);
        for (const binding of previous) this.runner.catalog.register(binding);
        if (previous.length > 0) this.#bindings.set(id, previous);
        throw error;
      }
    } catch (error) {
      this.#errors.set(id, error instanceof Error ? error.message : String(error));
    }
  }

  async #load(record: ModuleRecord): Promise<readonly CapabilityBinding[]> {
    const path = await this.#path(record);
    return loadCapabilityModule({
      path,
      exports: record.config.exports,
      ...(record.source === 'managed' ? { root: this.#requireWorkspace().root } : {}),
    });
  }

  #assertRegisterable(id: string, bindings: readonly CapabilityBinding[]): void {
    const currentIds = new Set(
      (this.#bindings.get(id) ?? []).map(({ definition }) => definition.id),
    );
    for (const binding of bindings) {
      const existing = this.runner.catalog.get(binding.definition.id);
      if (existing !== undefined && !currentIds.has(binding.definition.id)) {
        throw new CapabilityModuleServiceError(
          'MODULE_INVALID',
          `Capability '${binding.definition.id}' is already registered by '${existing.definition.source}'.`,
          400,
        );
      }
    }
  }

  #assertCapabilitiesUnused(id: string, replacements: readonly CapabilityBinding[]): void {
    const replacementIds = new Set(replacements.map(({ definition }) => definition.id));
    const removedIds = new Set(
      (this.#bindings.get(id) ?? [])
        .map(({ definition }) => definition.id)
        .filter((capabilityId) => !replacementIds.has(capabilityId)),
    );
    if (removedIds.size === 0) return;
    const consumers = this.runner
      .agents()
      .filter((agent) =>
        agentCapabilityIds(agent).some((capabilityId) => removedIds.has(capabilityId)),
      )
      .map((agent) => agent.id);
    if (consumers.length > 0) {
      throw new CapabilityModuleServiceError(
        'MODULE_IN_USE',
        `Capability module '${id}' is used by agent${consumers.length === 1 ? '' : 's'} ${consumers
          .map((agentId) => `'${agentId}'`)
          .join(', ')}.`,
        409,
      );
    }
  }

  #unregister(id: string): void {
    for (const binding of this.#bindings.get(id) ?? []) {
      this.runner.catalog.unregister(binding.definition.id);
    }
    this.#bindings.delete(id);
  }

  async #records(): Promise<readonly ModuleRecord[]> {
    const managed = (await this.repository.list())
      .filter(({ config }) => !this.#configured.has(config.id))
      .map(storedRecord);
    return [...this.#configured.values(), ...managed].sort((left, right) =>
      left.config.id.localeCompare(right.config.id),
    );
  }

  async #requireRecord(id: string): Promise<ModuleRecord> {
    const configured = this.#configured.get(id);
    if (configured !== undefined) return configured;
    const stored = await this.repository.get(id);
    if (stored === undefined) {
      throw new CapabilityModuleServiceError(
        'MODULE_NOT_FOUND',
        `Capability module '${id}' was not found.`,
        404,
      );
    }
    return storedRecord(stored);
  }

  async #assertAvailable(id: string): Promise<void> {
    if (this.#configured.has(id) || (await this.repository.get(id)) !== undefined) {
      throw new CapabilityModuleServiceError(
        'MODULE_ALREADY_EXISTS',
        `Capability module '${id}' already exists.`,
        409,
      );
    }
  }

  async #path(record: ModuleRecord): Promise<string> {
    return record.source === 'managed'
      ? this.#requireWorkspace().resolveExisting(record.config.path)
      : resolve(record.config.path);
  }

  #payload(record: ModuleRecord): CapabilityModulePayload {
    const bindings = this.#bindings.get(record.config.id) ?? [];
    const error = this.#errors.get(record.config.id);
    return {
      id: record.config.id,
      source: record.source,
      editable: record.source !== 'config',
      deletable: record.source !== 'config' && !this.#hasConsumers(record.config.id),
      status: !record.config.enabled ? 'disabled' : error === undefined ? 'active' : 'error',
      path: record.config.path,
      exports: record.config.exports,
      enabled: record.config.enabled,
      ...(error === undefined ? {} : { error }),
      capabilities: bindings.map(
        ({ definition }) => this.runner.catalog.get(definition.id)?.definition ?? definition,
      ),
      ...(record.createdAt === undefined ? {} : { createdAt: record.createdAt }),
      ...(record.updatedAt === undefined ? {} : { updatedAt: record.updatedAt }),
    };
  }

  #hasConsumers(id: string): boolean {
    const ids = new Set((this.#bindings.get(id) ?? []).map(({ definition }) => definition.id));
    return this.runner
      .agents()
      .some((agent) => agentCapabilityIds(agent).some((capabilityId) => ids.has(capabilityId)));
  }

  #requireWorkspace(): Workspace {
    if (this.#workspace === undefined) {
      throw new Error('Capability module service has not been initialized.');
    }
    return this.#workspace;
  }
}

function storedRecord(stored: StoredCapabilityModule): ModuleRecord {
  return {
    source: stored.config.source,
    config: {
      id: stored.config.id,
      path: stored.config.path,
      exports: stored.config.exports,
      enabled: stored.config.enabled,
    },
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  };
}

function storedRecordPreview(config: CapabilityModuleConfig): ModuleRecord {
  return {
    source: config.source,
    config: {
      id: config.id,
      path: config.path,
      exports: config.exports,
      enabled: config.enabled,
    },
  };
}

function validateExtension(filename: string): string {
  const extension = extname(filename).toLowerCase();
  if (!sourceExtensions.has(extension)) {
    throw new CapabilityModuleServiceError(
      'MODULE_INVALID',
      'Capability modules must use a .js, .mjs, .ts, or .mts extension.',
      400,
    );
  }
  return extension;
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
