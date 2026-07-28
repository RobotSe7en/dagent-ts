import type {
  DAGSpec,
  DagCondition,
  DagEdge,
  DagNode,
  ValueBinding,
  ValueExpression,
} from '../contracts/dag.js';
import { dagSpecSchema, valueExpressionSchema } from '../contracts/dag.js';
import { DagentError, errorMessage } from '../errors.js';
import { validateArtifactPath } from './artifact-path.js';

export type DagValidationIssue = {
  readonly code:
    | 'cycle'
    | 'duplicate-node'
    | 'invalid-artifact'
    | 'invalid-edge'
    | 'invalid-reference'
    | 'invalid-schema';
  readonly message: string;
  readonly path: string;
};

export type DagValidationResult =
  | { readonly valid: true; readonly graph: DAGSpec; readonly issues: readonly [] }
  | { readonly valid: false; readonly issues: readonly DagValidationIssue[] };

export type DagValidationScope = 'root' | 'map' | 'loop';

export function validateDag(input: unknown): DagValidationResult {
  return validateDagInScope(input, 'root');
}

export function validateDagInScope(input: unknown, scope: DagValidationScope): DagValidationResult {
  return validateDagInEnvironment(input, {
    allowItem: scope === 'map' || scope === 'loop',
    allowIteration: scope === 'loop',
  });
}

type ValidationEnvironment = {
  readonly allowItem: boolean;
  readonly allowIteration: boolean;
};

function validateDagInEnvironment(
  input: unknown,
  environment: ValidationEnvironment,
): DagValidationResult {
  const parsed = dagSpecSchema.safeParse(input);
  if (!parsed.success) {
    return {
      valid: false,
      issues: parsed.error.issues.map((issue) => ({
        code: 'invalid-schema',
        message: issue.message,
        path: issue.path.join('.'),
      })),
    };
  }

  const graph = parsed.data;
  const issues: DagValidationIssue[] = [];
  const nodeIds = new Set<string>();
  for (const [index, node] of graph.nodes.entries()) {
    if (nodeIds.has(node.id)) {
      issues.push({
        code: 'duplicate-node',
        message: `Node '${node.id}' is declared more than once.`,
        path: `nodes.${index}.id`,
      });
    }
    nodeIds.add(node.id);
  }

  const artifactIds = new Set(Object.keys(graph.artifacts));
  for (const [key, artifact] of Object.entries(graph.artifacts)) {
    if (artifact.id !== key) {
      issues.push({
        code: 'invalid-artifact',
        message: `Artifact key '${key}' does not match id '${artifact.id}'.`,
        path: `artifacts.${key}`,
      });
    }
    for (const [pathIndex, path] of artifact.paths.entries()) {
      try {
        validateArtifactPath(path);
      } catch (error) {
        issues.push({
          code: 'invalid-artifact',
          message: errorMessage(error),
          path: `artifacts.${key}.paths.${pathIndex}`,
        });
      }
    }
  }

  for (const [index, edge] of graph.edges.entries()) {
    validateEdge(edge, index, nodeIds, issues);
  }

  const predecessors = buildPredecessors(graph.edges);
  for (const [index, edge] of graph.edges.entries()) {
    if (edge.condition !== undefined) {
      validateConditionReferences(
        edge.condition,
        `edges.${index}.condition`,
        edge.to,
        predecessors,
        nodeIds,
        artifactIds,
        environment,
        issues,
      );
    }
  }
  const artifactProducers = new Map<string, string>();
  if (hasCycle(nodeIds, predecessors)) {
    issues.push({
      code: 'cycle',
      message: 'DAG edges contain a cycle. Use an explicit loop node for bounded iteration.',
      path: 'edges',
    });
  }

  for (const [index, node] of graph.nodes.entries()) {
    for (const artifactId of [...node.artifactInputs, ...node.artifactOutputs]) {
      if (!artifactIds.has(artifactId)) {
        issues.push({
          code: 'invalid-artifact',
          message: `Node '${node.id}' references unknown artifact '${artifactId}'.`,
          path: `nodes.${index}`,
        });
      }
    }
    for (const artifactId of new Set(node.artifactOutputs)) {
      const previous = artifactProducers.get(artifactId);
      if (previous !== undefined && previous !== node.id) {
        issues.push({
          code: 'invalid-artifact',
          message: `Artifact '${artifactId}' is produced by both '${previous}' and '${node.id}'.`,
          path: `nodes.${index}.artifactOutputs`,
        });
      } else {
        artifactProducers.set(artifactId, node.id);
      }
    }
    validateNodeReferences(node, index, predecessors, nodeIds, artifactIds, environment, issues);
    validateNestedGraph(node, index, issues);
  }

  for (const [index, node] of graph.nodes.entries()) {
    for (const artifactId of node.artifactInputs) {
      const producer = artifactProducers.get(artifactId);
      if (producer !== undefined && !isUpstream(producer, node.id, predecessors)) {
        issues.push({
          code: 'invalid-artifact',
          message: `Node '${node.id}' consumes artifact '${artifactId}' without depending on producer '${producer}'.`,
          path: `nodes.${index}.artifactInputs`,
        });
      }
    }
  }

  if (graph.output !== undefined) {
    validateBindingReferences(
      graph.output,
      'output',
      undefined,
      predecessors,
      nodeIds,
      artifactIds,
      environment,
      issues,
    );
  }

  return issues.length === 0 ? { valid: true, graph, issues: [] } : { valid: false, issues };
}

export function assertValidDag(input: unknown): DAGSpec {
  return assertValidDagInScope(input, 'root');
}

export function assertValidDagInScope(input: unknown, scope: DagValidationScope): DAGSpec {
  const result = validateDagInScope(input, scope);
  if (!result.valid) {
    throw new DagentError('DAG_VALIDATION_FAILED', 'The DAG is invalid.', {
      details: { issues: result.issues },
    });
  }
  return result.graph;
}

function validateEdge(
  edge: DagEdge,
  index: number,
  nodeIds: ReadonlySet<string>,
  issues: DagValidationIssue[],
): void {
  if (!nodeIds.has(edge.from)) {
    issues.push({
      code: 'invalid-edge',
      message: `Edge source '${edge.from}' does not exist.`,
      path: `edges.${index}.from`,
    });
  }
  if (!nodeIds.has(edge.to)) {
    issues.push({
      code: 'invalid-edge',
      message: `Edge target '${edge.to}' does not exist.`,
      path: `edges.${index}.to`,
    });
  }
  if (edge.from === edge.to) {
    issues.push({
      code: 'cycle',
      message: `Node '${edge.from}' cannot depend on itself.`,
      path: `edges.${index}`,
    });
  }
}

function buildPredecessors(edges: readonly DagEdge[]): ReadonlyMap<string, ReadonlySet<string>> {
  const predecessors = new Map<string, Set<string>>();
  for (const edge of edges) {
    const values = predecessors.get(edge.to) ?? new Set<string>();
    values.add(edge.from);
    predecessors.set(edge.to, values);
  }
  return predecessors;
}

function hasCycle(
  nodeIds: ReadonlySet<string>,
  predecessors: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  const visited = new Set<string>();
  const active = new Set<string>();

  const visit = (nodeId: string): boolean => {
    if (active.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;
    active.add(nodeId);
    for (const predecessor of predecessors.get(nodeId) ?? []) {
      if (visit(predecessor)) return true;
    }
    active.delete(nodeId);
    visited.add(nodeId);
    return false;
  };

  return [...nodeIds].some((nodeId) => visit(nodeId));
}

function validateNodeReferences(
  node: DagNode,
  index: number,
  predecessors: ReadonlyMap<string, ReadonlySet<string>>,
  nodeIds: ReadonlySet<string>,
  artifactIds: ReadonlySet<string>,
  environment: ValidationEnvironment,
  issues: DagValidationIssue[],
): void {
  const path = `nodes.${index}`;
  switch (node.kind) {
    case 'capability':
      validateBindingReferences(
        node.arguments,
        `${path}.arguments`,
        node.id,
        predecessors,
        nodeIds,
        artifactIds,
        environment,
        issues,
      );
      return;
    case 'agent':
      validateBindingReferences(
        node.prompt,
        `${path}.prompt`,
        node.id,
        predecessors,
        nodeIds,
        artifactIds,
        environment,
        issues,
      );
      return;
    case 'subgraph':
    case 'loop':
      validateBindingReferences(
        node.input,
        `${path}.input`,
        node.id,
        predecessors,
        nodeIds,
        artifactIds,
        environment,
        issues,
      );
      if (node.kind === 'loop') {
        validateConditionReferences(
          node.until,
          `${path}.until`,
          node.id,
          predecessors,
          nodeIds,
          artifactIds,
          { allowItem: true, allowIteration: true },
          issues,
        );
      }
      return;
    case 'map':
      validateBindingReferences(
        node.items,
        `${path}.items`,
        node.id,
        predecessors,
        nodeIds,
        artifactIds,
        environment,
        issues,
      );
      return;
  }
}

function validateNestedGraph(node: DagNode, index: number, issues: DagValidationIssue[]): void {
  if (node.kind === 'capability' || node.kind === 'agent') return;
  const result = validateDagInEnvironment(node.graph, {
    allowItem: node.kind === 'map' || node.kind === 'loop',
    allowIteration: node.kind === 'loop',
  });
  if (!result.valid) {
    for (const issue of result.issues) {
      issues.push({ ...issue, path: `nodes.${index}.graph.${issue.path}` });
    }
  }
}

function validateConditionReferences(
  condition: DagCondition,
  path: string,
  currentNodeId: string,
  predecessors: ReadonlyMap<string, ReadonlySet<string>>,
  nodeIds: ReadonlySet<string>,
  artifactIds: ReadonlySet<string>,
  environment: ValidationEnvironment,
  issues: DagValidationIssue[],
): void {
  if (condition.operator === 'truthy' || condition.operator === 'falsy') {
    validateBindingReferences(
      condition.value,
      `${path}.value`,
      currentNodeId,
      predecessors,
      nodeIds,
      artifactIds,
      environment,
      issues,
    );
  } else if (condition.operator === 'in') {
    validateBindingReferences(
      condition.value,
      `${path}.value`,
      currentNodeId,
      predecessors,
      nodeIds,
      artifactIds,
      environment,
      issues,
    );
    validateBindingReferences(
      condition.collection,
      `${path}.collection`,
      currentNodeId,
      predecessors,
      nodeIds,
      artifactIds,
      environment,
      issues,
    );
  } else {
    validateBindingReferences(
      condition.left,
      `${path}.left`,
      currentNodeId,
      predecessors,
      nodeIds,
      artifactIds,
      environment,
      issues,
    );
    validateBindingReferences(
      condition.right,
      `${path}.right`,
      currentNodeId,
      predecessors,
      nodeIds,
      artifactIds,
      environment,
      issues,
    );
  }
}

function validateBindingReferences(
  binding: ValueBinding,
  path: string,
  currentNodeId: string | undefined,
  predecessors: ReadonlyMap<string, ReadonlySet<string>>,
  nodeIds: ReadonlySet<string>,
  artifactIds: ReadonlySet<string>,
  environment: ValidationEnvironment,
  issues: DagValidationIssue[],
): void {
  walkBinding(binding, (expression, expressionPath) => {
    if (expression.type === 'node-output' || expression.type === 'node-status') {
      if (!nodeIds.has(expression.nodeId)) {
        issues.push({
          code: 'invalid-reference',
          message: `Value expression references unknown node '${expression.nodeId}'.`,
          path: `${path}${expressionPath}`,
        });
      } else if (
        currentNodeId !== undefined &&
        !isUpstream(expression.nodeId, currentNodeId, predecessors)
      ) {
        issues.push({
          code: 'invalid-reference',
          message: `Node '${currentNodeId}' reads '${expression.nodeId}' without an explicit dependency path.`,
          path: `${path}${expressionPath}`,
        });
      }
    }
    if (expression.type === 'artifact' && !artifactIds.has(expression.artifactId)) {
      issues.push({
        code: 'invalid-artifact',
        message: `Value expression references unknown artifact '${expression.artifactId}'.`,
        path: `${path}${expressionPath}`,
      });
    }
    if (expression.type === 'item' && !environment.allowItem) {
      issues.push({
        code: 'invalid-reference',
        message: 'Item expressions are only valid inside map and loop graphs.',
        path: `${path}${expressionPath}`,
      });
    }
    if (expression.type === 'iteration' && !environment.allowIteration) {
      issues.push({
        code: 'invalid-reference',
        message: 'Iteration expressions are only valid inside loop graphs.',
        path: `${path}${expressionPath}`,
      });
    }
  });
}

function walkBinding(
  binding: ValueBinding,
  visit: (expression: ValueExpression, path: string) => void,
  path = '',
): void {
  if (binding === null || typeof binding !== 'object') return;
  if (isExpressionBinding(binding)) {
    visit(binding.$expr, path);
    return;
  }
  if (Array.isArray(binding)) {
    (binding as readonly ValueBinding[]).forEach((value, index) => {
      walkBinding(value, visit, `${path}.${index}`);
    });
    return;
  }
  for (const [key, value] of Object.entries(binding)) {
    walkBinding(value, visit, `${path}.${key}`);
  }
}

function isExpressionBinding(value: ValueBinding): value is { readonly $expr: ValueExpression } {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    '$expr' in value &&
    valueExpressionSchema.safeParse(value.$expr).success
  );
}

function isUpstream(
  sourceId: string,
  targetId: string,
  predecessors: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  const queue = [...(predecessors.get(targetId) ?? [])];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const candidate = queue.shift();
    if (candidate === undefined) break;
    if (candidate === sourceId) return true;
    if (visited.has(candidate)) continue;
    visited.add(candidate);
    queue.push(...(predecessors.get(candidate) ?? []));
  }
  return false;
}
