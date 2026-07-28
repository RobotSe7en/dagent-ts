import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { AutoAgent, DagAgent, JsonObject, Runner, ToolAgent } from 'dagent-ai';
import { tool } from 'dagent-ai';
import type { CapabilityBinding } from 'dagent-ai/capabilities';
import { capabilityIdSchema, jsonValueSchema } from 'dagent-ai/contracts';
import type { CapabilityDefinition, CapabilityResult } from 'dagent-ai/contracts';
import { z } from 'zod';

import type {
  StoredTemplateCapability,
  TemplateCapabilityConfig,
  TemplateCapabilityRepository,
} from '../database/template-capability-repository.js';
import type { AppRepository } from '../database/repositories.js';

const disabledSettingKey = 'capabilities.disabled';
const disabledCapabilitiesSchema = z.array(capabilityIdSchema);

export type TemplateCapabilityPayload = {
  readonly config: TemplateCapabilityConfig;
  readonly definition: CapabilityDefinition;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export class CapabilityServiceError extends Error {
  public constructor(
    public readonly code:
      | 'CAPABILITY_ALREADY_EXISTS'
      | 'CAPABILITY_IN_USE'
      | 'CAPABILITY_NOT_FOUND'
      | 'CAPABILITY_NOT_MANAGED',
    message: string,
    public readonly statusCode: 400 | 404 | 409,
  ) {
    super(message);
    this.name = 'CapabilityServiceError';
  }
}

export class CapabilityService {
  public constructor(
    private readonly runner: Runner,
    private readonly repository: AppRepository,
    private readonly templates: TemplateCapabilityRepository,
  ) {}

  public async initialize(): Promise<void> {
    for (const stored of await this.templates.list()) {
      const binding = templateBinding(stored.config);
      if (this.runner.catalog.get(binding.definition.id) !== undefined) {
        throw new CapabilityServiceError(
          'CAPABILITY_ALREADY_EXISTS',
          `Capability '${binding.definition.id}' is already registered.`,
          409,
        );
      }
      this.runner.catalog.register(binding);
    }
    const persisted = await this.repository.setting(disabledSettingKey);
    const disabled = persisted === undefined ? [] : disabledCapabilitiesSchema.parse(persisted);
    for (const id of disabled) this.runner.catalog.setEnabled(id, false);
  }

  public list(kind?: CapabilityDefinition['kind']): {
    readonly capabilities: readonly CapabilityDefinition[];
  } {
    return {
      capabilities: this.runner.catalog
        .definitions()
        .filter((definition) => kind === undefined || definition.kind === kind)
        .sort((left, right) => left.id.localeCompare(right.id)),
    };
  }

  public get(id: string): CapabilityDefinition {
    const binding = this.runner.catalog.get(id);
    if (binding === undefined) {
      throw new CapabilityServiceError(
        'CAPABILITY_NOT_FOUND',
        `Capability '${id}' was not found.`,
        404,
      );
    }
    return binding.definition;
  }

  public async listTemplates(): Promise<{
    readonly capabilities: readonly TemplateCapabilityPayload[];
  }> {
    return {
      capabilities: (await this.templates.list()).map((stored) => this.#templatePayload(stored)),
    };
  }

  public async createTemplate(
    config: TemplateCapabilityConfig,
  ): Promise<TemplateCapabilityPayload> {
    if (this.runner.catalog.get(config.id) !== undefined) {
      throw new CapabilityServiceError(
        'CAPABILITY_ALREADY_EXISTS',
        `Capability '${config.id}' already exists.`,
        409,
      );
    }
    const binding = templateBinding(config);
    const stored = await this.templates.create(config);
    try {
      this.runner.catalog.register(binding);
    } catch (error) {
      await this.templates.delete(config.id);
      throw error;
    }
    return this.#templatePayload(stored);
  }

  public async updateTemplate(
    id: string,
    config: TemplateCapabilityConfig,
  ): Promise<TemplateCapabilityPayload> {
    if (config.id !== id) {
      throw new CapabilityServiceError(
        'CAPABILITY_NOT_MANAGED',
        `Capability id '${config.id}' does not match route id '${id}'.`,
        400,
      );
    }
    if ((await this.templates.get(id)) === undefined) {
      throw new CapabilityServiceError(
        'CAPABILITY_NOT_MANAGED',
        `Capability '${id}' is not a managed template capability.`,
        400,
      );
    }
    const binding = templateBinding(config);
    const stored = await this.templates.update(id, config);
    if (stored === undefined) {
      throw new CapabilityServiceError(
        'CAPABILITY_NOT_FOUND',
        `Capability '${id}' was not found.`,
        404,
      );
    }
    this.runner.catalog.replace(binding);
    return this.#templatePayload(stored);
  }

  public async deleteTemplate(id: string): Promise<void> {
    if ((await this.templates.get(id)) === undefined) {
      throw new CapabilityServiceError(
        'CAPABILITY_NOT_MANAGED',
        `Capability '${id}' is not a managed template capability.`,
        400,
      );
    }
    this.#assertUnused(id);
    await this.templates.delete(id);
    this.runner.catalog.unregister(id);
    this.runner.catalog.setEnabled(id, true);
    await this.#persistDisabled();
  }

  public async setEnabled(id: string, enabled: boolean): Promise<CapabilityDefinition> {
    if (this.runner.catalog.get(id) === undefined) {
      throw new CapabilityServiceError(
        'CAPABILITY_NOT_FOUND',
        `Capability '${id}' was not found.`,
        404,
      );
    }
    if (!enabled) this.#assertUnused(id);
    const updated = this.runner.catalog.setEnabled(id, enabled);
    if (updated === undefined) {
      throw new CapabilityServiceError(
        'CAPABILITY_NOT_FOUND',
        `Capability '${id}' was not found.`,
        404,
      );
    }
    await this.#persistDisabled();
    return updated.definition;
  }

  public async test(
    id: string,
    arguments_: JsonObject,
    metadata: JsonObject = {},
  ): Promise<CapabilityResult> {
    this.get(id);
    const workspacePath = join(this.runner.workspacePath, 'capability-tests', crypto.randomUUID());
    await mkdir(workspacePath, { recursive: true });
    return (
      await this.runner.catalog.invoke(id, arguments_, {
        runId: `capability_test_${crypto.randomUUID()}` as never,
        workspacePath,
        signal: new AbortController().signal,
        metadata,
      })
    ).result;
  }

  async #persistDisabled(): Promise<void> {
    await this.repository.setSetting(
      disabledSettingKey,
      disabledCapabilitiesSchema.parse(this.runner.catalog.disabledIds()),
    );
  }

  #templatePayload(stored: StoredTemplateCapability): TemplateCapabilityPayload {
    return {
      config: stored.config,
      definition: this.get(stored.config.id),
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
    };
  }

  #assertUnused(capabilityId: string): void {
    const consumers = this.runner
      .agents()
      .filter((agent) => agentCapabilityIds(agent).includes(capabilityId))
      .map((agent) => agent.id);
    if (consumers.length === 0) return;
    throw new CapabilityServiceError(
      'CAPABILITY_IN_USE',
      `Capability '${capabilityId}' is used by agent${consumers.length === 1 ? '' : 's'} ${consumers
        .map((id) => `'${id}'`)
        .join(', ')}.`,
      409,
    );
  }
}

function templateBinding(config: TemplateCapabilityConfig): CapabilityBinding {
  let input: z.ZodType<Record<string, unknown>>;
  try {
    input = z.fromJSONSchema(config.inputSchema) as z.ZodType<Record<string, unknown>>;
  } catch (error) {
    throw new TypeError(`Capability '${config.id}' has an invalid input JSON Schema.`, {
      cause: error,
    });
  }
  return tool({
    id: config.id as `tool.${string}`,
    name: config.name,
    description: config.description,
    input,
    output: z.string(),
    risk: config.risk,
    boundary: config.boundary,
    source: 'managed:template',
    execute: (arguments_) => renderTemplate(config.template, arguments_),
  });
}

function renderTemplate(template: string, arguments_: Record<string, unknown>): string {
  const openBrace = '\u0000dagent-open\u0000';
  const closeBrace = '\u0000dagent-close\u0000';
  const protectedTemplate = template.replaceAll('{{', openBrace).replaceAll('}}', closeBrace);
  const rendered = protectedTemplate.replace(
    /\{([A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)*)\}/gu,
    (_match, pathValue: string) => stringifyTemplateValue(readPath(arguments_, pathValue)),
  );
  return rendered.replaceAll(openBrace, '{').replaceAll(closeBrace, '}');
}

function readPath(root: Record<string, unknown>, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null || !(segment in current)) {
      throw new TypeError(`Template variable '${path}' is missing.`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function stringifyTemplateValue(value: unknown): string {
  if (typeof value === 'string') return value;
  const parsed = jsonValueSchema.safeParse(value);
  if (!parsed.success) throw new TypeError('Template values must be JSON-compatible.');
  if (parsed.data === null || typeof parsed.data === 'object') {
    return JSON.stringify(parsed.data);
  }
  return String(parsed.data);
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
