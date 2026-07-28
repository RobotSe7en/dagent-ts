import type { AutoAgent, DagAgent, Runner, ToolAgent } from 'dagent-ai';

import type { AgentConfig, AgentRepository, StoredAgent } from '../database/agent-repository.js';

export class AgentServiceError extends Error {
  public constructor(
    public readonly code: 'AGENT_ALREADY_EXISTS' | 'AGENT_NOT_FOUND' | 'AGENT_SCOPE_INVALID',
    message: string,
    public readonly statusCode: 400 | 404 | 409,
  ) {
    super(message);
    this.name = 'AgentServiceError';
  }
}

export class AgentService {
  public constructor(
    private readonly runner: Runner,
    private readonly repository: AgentRepository,
  ) {}

  public async initialize(): Promise<void> {
    for (const stored of await this.repository.list()) {
      await this.#validateScope(stored.config);
      this.runner.replaceAgent(stored.config);
    }
  }

  public list(): Promise<readonly StoredAgent[]> {
    return this.repository.list();
  }

  public async get(id: string): Promise<StoredAgent> {
    const stored = await this.repository.get(id);
    if (stored === undefined) {
      throw new AgentServiceError('AGENT_NOT_FOUND', `Agent '${id}' was not found.`, 404);
    }
    return stored;
  }

  public async create(config: AgentConfig): Promise<StoredAgent> {
    if (
      (await this.repository.get(config.id)) !== undefined ||
      this.runner.agent(config.id) !== undefined
    ) {
      throw new AgentServiceError(
        'AGENT_ALREADY_EXISTS',
        `Agent '${config.id}' already exists.`,
        409,
      );
    }
    await this.#validateScope(config);
    const stored = await this.repository.create(config);
    this.runner.registerAgent(stored.config);
    return stored;
  }

  public async update(id: string, config: AgentConfig): Promise<StoredAgent> {
    if (config.id !== id) {
      throw new AgentServiceError(
        'AGENT_SCOPE_INVALID',
        `Agent config id '${config.id}' does not match route id '${id}'.`,
        400,
      );
    }
    if ((await this.repository.get(id)) === undefined) {
      throw new AgentServiceError('AGENT_NOT_FOUND', `Agent '${id}' was not found.`, 404);
    }
    await this.#validateScope(config);
    const stored = await this.repository.update(id, config);
    if (stored === undefined) {
      throw new AgentServiceError('AGENT_NOT_FOUND', `Agent '${id}' was not found.`, 404);
    }
    this.runner.replaceAgent(stored.config);
    return stored;
  }

  public async delete(id: string): Promise<void> {
    if (!(await this.repository.delete(id))) {
      throw new AgentServiceError('AGENT_NOT_FOUND', `Agent '${id}' was not found.`, 404);
    }
    this.runner.unregisterAgent(id);
  }

  async #validateScope(config: AgentConfig): Promise<void> {
    for (const capabilityId of agentCapabilityIds(config)) {
      const binding = this.runner.catalog.get(capabilityId);
      if (binding === undefined || !binding.definition.enabled) {
        throw new AgentServiceError(
          'AGENT_SCOPE_INVALID',
          `Agent '${config.id}' references unavailable capability '${capabilityId}'.`,
          400,
        );
      }
    }
    for (const skillName of agentSkillIds(config)) {
      try {
        await this.runner.skills.view(skillName);
      } catch {
        throw new AgentServiceError(
          'AGENT_SCOPE_INVALID',
          `Agent '${config.id}' references unavailable skill '${skillName}'.`,
          400,
        );
      }
    }
  }
}

function agentCapabilityIds(config: ToolAgent | DagAgent | AutoAgent): readonly string[] {
  if (config.kind !== 'auto-agent') return config.scope.capabilities;
  return [
    ...new Set([
      ...config.scope.capabilities,
      ...config.toolAgent.scope.capabilities,
      ...config.dagAgent.scope.capabilities,
    ]),
  ];
}

function agentSkillIds(config: ToolAgent | DagAgent | AutoAgent): readonly string[] {
  if (config.kind !== 'auto-agent') return config.scope.skills;
  return [
    ...new Set([
      ...config.scope.skills,
      ...config.toolAgent.scope.skills,
      ...config.dagAgent.scope.skills,
    ]),
  ];
}
