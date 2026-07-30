import type { CapabilityCatalog } from '../capabilities/catalog.js';
import type {
  AutoAgent,
  CapabilityScope,
  DAGSpec,
  DagAgent,
  ResolvedRunPlan,
  RunTarget,
  ToolAgent,
} from '../contracts/index.js';
import type { JsonValue } from '../contracts/index.js';
import { DagentError } from '../errors.js';
import { sha256 } from '../internal/stable-json.js';
import type { SkillStore } from '../skills/index.js';
import { graphAgentIds, graphCapabilityIds } from '../domain/dag-transition.js';

export type RegisteredAgent = ToolAgent | DagAgent | AutoAgent;
export type AgentRegistry = ReadonlyMap<string, RegisteredAgent>;

export type ExecutionScopeSnapshot = {
  readonly capabilityIds: readonly string[];
  readonly capabilityFingerprints: Readonly<Record<string, string>>;
  readonly skillIds: readonly string[];
  readonly agentIds: readonly string[];
  readonly agentFingerprints: Readonly<Record<string, string>>;
};

export async function resolveExecutionScope(
  target: RunTarget,
  catalog: CapabilityCatalog,
  agents: AgentRegistry,
  skills: SkillStore,
): Promise<ExecutionScopeSnapshot> {
  const scopes = targetScopes(target);
  const capabilityIds = new Set(
    target.kind === 'static-dag'
      ? graphCapabilityIds(target.graph)
      : scopes.flatMap(({ capabilities }) => capabilities),
  );
  const skillIds = new Set(
    target.kind === 'static-dag' ? [] : scopes.flatMap(({ skills: scopeSkills }) => scopeSkills),
  );
  const agentIds = new Set(
    target.kind === 'static-dag'
      ? graphAgentIds(target.graph)
      : target.kind === 'tool-agent'
        ? []
        : target.kind === 'dag-agent'
          ? target.scope.agents
          : [...target.scope.agents, ...target.dagAgent.scope.agents],
  );
  const resolvedAgents = resolveAgents(agentIds, agents, 'INVALID_INPUT');
  for (const agent of resolvedAgents.values()) {
    for (const capabilityId of agent.scope.capabilities) capabilityIds.add(capabilityId);
    for (const skillId of agent.scope.skills) skillIds.add(skillId);
  }
  if (skillIds.size > 0) {
    capabilityIds.add('skill.list');
    capabilityIds.add('skill.view');
  }
  await assertSkillsAvailable([...skillIds], skills, 'INVALID_INPUT');

  const sortedCapabilities = [...capabilityIds].sort();
  const sortedAgents = [...agentIds].sort();
  return {
    capabilityIds: sortedCapabilities,
    capabilityFingerprints: Object.fromEntries(
      sortedCapabilities.map((id) => [id, definitionFingerprint(catalog.require(id).definition)]),
    ),
    skillIds: [...skillIds].sort(),
    agentIds: sortedAgents,
    agentFingerprints: Object.fromEntries(
      sortedAgents.map((id) => [id, agentFingerprint(resolvedAgents.get(id) as ToolAgent)]),
    ),
  };
}

export async function validateResolvedExecutionScope(
  plan: ResolvedRunPlan,
  catalog: CapabilityCatalog,
  agents: AgentRegistry,
  skills: SkillStore,
): Promise<void> {
  for (const capabilityId of plan.capabilityIds) {
    const binding = catalog.get(capabilityId);
    if (binding === undefined || !binding.definition.enabled) {
      throw new DagentError(
        'CHECKPOINT_MISMATCH',
        `Checkpoint capability is unavailable: ${capabilityId}`,
      );
    }
    if (plan.capabilityFingerprints[capabilityId] !== definitionFingerprint(binding.definition)) {
      throw new DagentError(
        'CHECKPOINT_MISMATCH',
        `Checkpoint capability definition changed: ${capabilityId}`,
      );
    }
  }
  const resolvedAgents = resolveAgents(plan.agentIds, agents, 'CHECKPOINT_MISMATCH');
  for (const agentId of plan.agentIds) {
    if (
      plan.agentFingerprints[agentId] !== agentFingerprint(resolvedAgents.get(agentId) as ToolAgent)
    ) {
      throw new DagentError(
        'CHECKPOINT_MISMATCH',
        `Checkpoint agent definition changed: ${agentId}`,
      );
    }
  }
  await assertSkillsAvailable(plan.skillIds, skills, 'CHECKPOINT_MISMATCH');
}

export function resolvedAgentsForPlan(
  plan: ResolvedRunPlan,
  agents: AgentRegistry,
): ReadonlyMap<string, ToolAgent> {
  const resolved = resolveAgents(plan.agentIds, agents, 'CHECKPOINT_MISMATCH');
  for (const [agentId, agent] of resolved) {
    if (plan.agentFingerprints[agentId] !== agentFingerprint(agent)) {
      throw new DagentError('CHECKPOINT_MISMATCH', `Resolved agent definition changed: ${agentId}`);
    }
  }
  return resolved;
}

export function plannerAgents(
  agent: DagAgent,
  plan: ResolvedRunPlan,
  agents: AgentRegistry,
): readonly ToolAgent[] {
  const resolved = resolvedAgentsForPlan(plan, agents);
  return agent.scope.agents.map((agentId) => {
    const nested = resolved.get(agentId);
    if (nested === undefined) {
      throw new DagentError(
        'CHECKPOINT_MISMATCH',
        `Planner agent '${agentId}' is outside the resolved execution scope.`,
      );
    }
    return nested;
  });
}

export function graphRequiresRiskReview(
  graph: DAGSpec,
  catalog: CapabilityCatalog,
  agents: AgentRegistry,
): boolean {
  const capabilityIds = new Set(graphCapabilityIds(graph));
  for (const agent of resolveAgents(graphAgentIds(graph), agents, 'INVALID_INPUT').values()) {
    if (agent.reviewLevel === 'always') return true;
    for (const capabilityId of agent.scope.capabilities) capabilityIds.add(capabilityId);
  }
  return [...capabilityIds].some((capabilityId) => {
    const risk = catalog.require(capabilityId).definition.risk;
    return risk === 'high' || risk === 'critical';
  });
}

export function assertGraphWithinPlan(graph: DAGSpec, plan: ResolvedRunPlan): void {
  const capabilities = new Set(plan.capabilityIds);
  for (const capabilityId of graphCapabilityIds(graph)) {
    if (!capabilities.has(capabilityId)) {
      throw new DagentError(
        'CHECKPOINT_MISMATCH',
        `DAG references capability outside the resolved plan: ${capabilityId}`,
      );
    }
  }
  const agents = new Set(plan.agentIds);
  for (const agentId of graphAgentIds(graph)) {
    if (!agents.has(agentId)) {
      throw new DagentError(
        'CHECKPOINT_MISMATCH',
        `DAG references agent outside the resolved plan: ${agentId}`,
      );
    }
  }
}

function targetScopes(target: RunTarget): CapabilityScope[] {
  if (target.kind === 'static-dag') return [];
  if (target.kind === 'auto-agent') {
    return [target.scope, target.toolAgent.scope, target.dagAgent.scope];
  }
  return [target.scope];
}

function resolveAgents(
  ids: Iterable<string>,
  agents: AgentRegistry,
  errorCode: 'INVALID_INPUT' | 'CHECKPOINT_MISMATCH',
): Map<string, ToolAgent> {
  const resolved = new Map<string, ToolAgent>();
  for (const id of ids) {
    const agent = agents.get(id);
    if (agent === undefined) {
      throw new DagentError(errorCode, `Agent '${id}' is not registered.`);
    }
    if (agent.kind !== 'tool-agent') {
      throw new DagentError(errorCode, `Nested agent '${id}' must be a ToolAgent.`);
    }
    resolved.set(id, agent);
  }
  return resolved;
}

async function assertSkillsAvailable(
  skillIds: readonly string[],
  skills: SkillStore,
  errorCode: 'INVALID_INPUT' | 'CHECKPOINT_MISMATCH',
): Promise<void> {
  for (const skillId of skillIds) {
    try {
      await skills.view(skillId);
    } catch (error) {
      throw new DagentError(errorCode, `Skill '${skillId}' is unavailable.`, { cause: error });
    }
  }
}

function definitionFingerprint(definition: unknown): string {
  return sha256(JSON.parse(JSON.stringify(definition)) as JsonValue);
}

function agentFingerprint(agent: ToolAgent): string {
  return sha256(JSON.parse(JSON.stringify(agent)) as JsonValue);
}
