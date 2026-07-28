import { resolve, sep } from 'node:path';

import type {
  DAGSpec,
  DagCondition,
  DagNodeResult,
  ValueBinding,
  ValueExpression,
} from '../contracts/dag.js';
import { valueExpressionSchema } from '../contracts/dag.js';
import type { JsonObject, JsonValue } from '../contracts/common.js';
import { DagentError } from '../errors.js';

export type ValueResolutionContext = {
  readonly graphInput: JsonObject;
  readonly nodeResults: Readonly<Record<string, DagNodeResult>>;
  readonly nodeValues?: Readonly<Record<string, JsonValue>>;
  readonly graph: DAGSpec;
  readonly workspacePath: string;
  readonly item?: JsonValue;
  readonly iteration?: number;
};

export function resolveBinding(binding: ValueBinding, context: ValueResolutionContext): JsonValue {
  if (binding === null || typeof binding !== 'object') return binding;
  if (isExpressionBinding(binding)) return resolveExpression(binding.$expr, context);
  if (Array.isArray(binding)) {
    return (binding as readonly ValueBinding[]).map((value) => resolveBinding(value, context));
  }
  return Object.fromEntries(
    Object.entries(binding).map(([key, value]) => [key, resolveBinding(value, context)]),
  );
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

export function evaluateCondition(
  condition: DagCondition,
  context: ValueResolutionContext,
): boolean {
  if (condition.operator === 'truthy') return Boolean(resolveBinding(condition.value, context));
  if (condition.operator === 'falsy') return !resolveBinding(condition.value, context);
  if (condition.operator === 'in') {
    const value = resolveBinding(condition.value, context);
    const collection = resolveBinding(condition.collection, context);
    if (Array.isArray(collection)) return collection.some((item) => Object.is(item, value));
    if (typeof collection === 'string' && typeof value === 'string') {
      return collection.includes(value);
    }
    return false;
  }
  const left = resolveBinding(condition.left, context);
  const right = resolveBinding(condition.right, context);
  switch (condition.operator) {
    case 'eq':
      return JSON.stringify(left) === JSON.stringify(right);
    case 'neq':
      return JSON.stringify(left) !== JSON.stringify(right);
    case 'gt':
      return compare(left, right) > 0;
    case 'gte':
      return compare(left, right) >= 0;
    case 'lt':
      return compare(left, right) < 0;
    case 'lte':
      return compare(left, right) <= 0;
  }
}

function resolveExpression(
  expression: ValueExpression,
  context: ValueResolutionContext,
): JsonValue {
  switch (expression.type) {
    case 'graph-input':
      return readPath(context.graphInput, expression.path);
    case 'node-output': {
      const result = context.nodeResults[expression.nodeId];
      if (result?.status === 'skipped') return null;
      if (result?.status !== 'completed' || result.output === undefined) {
        throw new DagentError(
          'DAG_EXECUTION_FAILED',
          `Node '${expression.nodeId}' has no completed output.`,
        );
      }
      return readPath(context.nodeValues?.[expression.nodeId] ?? result.output, expression.path);
    }
    case 'node-status':
      return context.nodeResults[expression.nodeId]?.status ?? 'pending';
    case 'artifact': {
      const artifact = context.graph.artifacts[expression.artifactId];
      if (artifact === undefined) {
        throw new DagentError(
          'DAG_EXECUTION_FAILED',
          `Artifact '${expression.artifactId}' does not exist.`,
        );
      }
      const absolutePaths = artifact.paths.map((path) =>
        resolveWorkspacePath(context.workspacePath, path),
      );
      switch (expression.field) {
        case 'path':
          return artifact.paths[0] ?? '';
        case 'paths':
          return artifact.paths;
        case 'absolutePath':
          return absolutePaths[0] ?? '';
        case 'absolutePaths':
          return absolutePaths;
      }
      throw new DagentError(
        'INVALID_INPUT',
        `Unsupported artifact field '${String(expression.field)}'.`,
      );
    }
    case 'item':
      return readPath(context.item ?? null, expression.path);
    case 'iteration':
      return context.iteration ?? 0;
    case 'format':
      return expression.template.replace(/\{([A-Za-z0-9_-]+)\}/g, (match, key: string) => {
        const raw = expression.values[key];
        if (raw === undefined) return match;
        const resolved = resolveUnknownBinding(raw, context);
        return typeof resolved === 'string' ? resolved : JSON.stringify(resolved);
      });
  }
}

function resolveUnknownBinding(value: unknown, context: ValueResolutionContext): JsonValue {
  return resolveBinding(value as ValueBinding, context);
}

function readPath(root: JsonValue, path: readonly (string | number)[]): JsonValue {
  let current: JsonValue | undefined = root;
  for (const segment of path) {
    if (Array.isArray(current) && typeof segment === 'number') {
      current = current[segment];
    } else if (
      current !== null &&
      typeof current === 'object' &&
      !Array.isArray(current) &&
      typeof segment === 'string'
    ) {
      current = current[segment];
    } else {
      current = undefined;
    }
    if (current === undefined) {
      throw new DagentError(
        'DAG_EXECUTION_FAILED',
        `Value path '${path.join('.')}' was not found.`,
      );
    }
  }
  return current;
}

function resolveWorkspacePath(workspacePath: string, candidate: string): string {
  const root = resolve(workspacePath);
  const result = resolve(root, candidate);
  if (result !== root && !result.startsWith(`${root}${sep}`)) {
    throw new DagentError(
      'WORKSPACE_VIOLATION',
      `Artifact path '${candidate}' escapes the run workspace.`,
    );
  }
  return result;
}

function compare(left: JsonValue, right: JsonValue): number {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  if (typeof left === 'string' && typeof right === 'string') return left.localeCompare(right);
  throw new DagentError(
    'DAG_EXECUTION_FAILED',
    'Ordered comparisons require two numbers or strings.',
  );
}
