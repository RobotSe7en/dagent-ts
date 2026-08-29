import { z } from 'zod';

import type { CapabilityBinding } from './capabilities/tool.js';
import type {
  DAGSpec,
  ConditionCase,
  DagCondition,
  DagEdge,
  DagNode,
  ValueBinding,
  ValueExpression,
} from './contracts/dag.js';
import type { Artifact } from './contracts/artifact.js';
import { dagSpecSchema } from './contracts/dag.js';
import { conditionSchema } from './contracts/dag.js';
import { assertValidDagInScope } from './domain/dag-validation.js';
import { deepFreeze } from './internal/deep-freeze.js';

export class ValueRef<T = unknown> {
  readonly #expression: ValueExpression;

  public constructor(expression: ValueExpression) {
    this.#expression = expression;
  }

  public at<TKey extends PathKey<T>>(key: TKey): ValueRef<T[TKey]>;
  public at<TKey extends PathKey<T>, TNestedKey extends PathKey<T[TKey]>>(
    key: TKey,
    nestedKey: TNestedKey,
  ): ValueRef<T[TKey][TNestedKey]>;
  public at(...path: readonly (string | number)[]): ValueRef;
  public at(...path: readonly (string | number)[]): ValueRef {
    const expression = this.#expression;
    if (
      expression.type !== 'graph-input' &&
      expression.type !== 'node-output' &&
      expression.type !== 'item'
    ) {
      throw new TypeError(`Expression '${expression.type}' does not support nested paths.`);
    }
    return new ValueRef({ ...expression, path: [...expression.path, ...path] });
  }

  public toBinding(): { readonly $expr: ValueExpression } {
    return { $expr: this.#expression };
  }

  declare public readonly __value?: T;
}

export class NodeRef<TOutput = unknown> {
  public readonly id: string;

  public constructor(id: string) {
    this.id = id;
  }

  public output(): ValueRef<TOutput>;
  public output<TKey extends PathKey<TOutput>>(key: TKey): ValueRef<TOutput[TKey]>;
  public output<TKey extends PathKey<TOutput>, TNestedKey extends PathKey<TOutput[TKey]>>(
    key: TKey,
    nestedKey: TNestedKey,
  ): ValueRef<TOutput[TKey][TNestedKey]>;
  public output(...path: readonly (string | number)[]): ValueRef;
  public output(...path: readonly (string | number)[]): ValueRef {
    return new ValueRef({ type: 'node-output', nodeId: this.id, path: [...path] });
  }

  public status(): ValueRef<string> {
    return new ValueRef({ type: 'node-status', nodeId: this.id });
  }
}

export class ArtifactRef {
  public readonly id: string;

  public constructor(id: string) {
    this.id = id;
  }

  public path(): ValueRef<string> {
    return new ValueRef({ type: 'artifact', artifactId: this.id, field: 'path' });
  }

  public paths(): ValueRef<readonly string[]> {
    return new ValueRef({ type: 'artifact', artifactId: this.id, field: 'paths' });
  }

  public absolutePath(): ValueRef<string> {
    return new ValueRef({ type: 'artifact', artifactId: this.id, field: 'absolutePath' });
  }
}

export type DagBuilderOptions<TInput, TOutput> = {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly input?: z.ZodType<TInput>;
  readonly output?: z.ZodType<TOutput>;
  readonly executionScope?: 'root' | 'map' | 'loop';
};

export type TypedDagSpec<TInput = unknown, TOutput = unknown> = DAGSpec & {
  readonly __input?: TInput;
  readonly __output?: TOutput;
};

export type NodeOptions = {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  readonly after?: readonly NodeRef[];
  readonly when?: DagCondition;
  readonly artifactInputs?: readonly ArtifactRef[];
  readonly artifactOutputs?: readonly ArtifactRef[];
};

export type ConditionNodeOptions = Omit<NodeOptions, 'artifactInputs' | 'artifactOutputs'>;

export type EdgeOptions = {
  readonly condition?: DagCondition;
  readonly branch?: string;
};

export function allOf(...conditions: readonly DagCondition[]): DagCondition {
  return conditionSchema.parse({ operator: 'all', conditions });
}

export function anyOf(...conditions: readonly DagCondition[]): DagCondition {
  return conditionSchema.parse({ operator: 'any', conditions });
}

export function notCondition(condition: DagCondition): DagCondition {
  return conditionSchema.parse({ operator: 'not', condition });
}

export class DagBuilder<TInput = Record<string, unknown>, TOutput = unknown, TItem = unknown> {
  readonly #options: DagBuilderOptions<TInput, TOutput>;
  readonly #nodes = new Map<string, DagNode>();
  readonly #edges: DagEdge[] = [];
  readonly #artifacts = new Map<string, Artifact>();
  #output: ValueBinding | undefined;

  public constructor(options: DagBuilderOptions<TInput, TOutput>) {
    this.#options = options;
  }

  public input(): ValueRef<TInput>;
  public input<TKey extends PathKey<TInput>>(key: TKey): ValueRef<TInput[TKey]>;
  public input<TKey extends PathKey<TInput>, TNestedKey extends PathKey<TInput[TKey]>>(
    key: TKey,
    nestedKey: TNestedKey,
  ): ValueRef<TInput[TKey][TNestedKey]>;
  public input(...path: readonly (string | number)[]): ValueRef;
  public input(...path: readonly (string | number)[]): ValueRef {
    return new ValueRef({ type: 'graph-input', path: [...path] });
  }

  public item(): ValueRef<TItem>;
  public item<TKey extends PathKey<TItem>>(key: TKey): ValueRef<TItem[TKey]>;
  public item<TKey extends PathKey<TItem>, TNestedKey extends PathKey<TItem[TKey]>>(
    key: TKey,
    nestedKey: TNestedKey,
  ): ValueRef<TItem[TKey][TNestedKey]>;
  public item(...path: readonly (string | number)[]): ValueRef;
  public item(...path: readonly (string | number)[]): ValueRef {
    if (this.#options.executionScope === undefined || this.#options.executionScope === 'root') {
      throw new TypeError('Item references require a map or loop DAG builder executionScope.');
    }
    return new ValueRef({ type: 'item', path: [...path] });
  }

  public iteration(): ValueRef<number> {
    if (this.#options.executionScope !== 'loop') {
      throw new TypeError('Iteration references require a loop DAG builder executionScope.');
    }
    return new ValueRef({ type: 'iteration' });
  }

  public artifact(
    id: string,
    paths: string | readonly string[],
    options: {
      readonly description?: string;
      readonly required?: boolean;
      readonly metadata?: Artifact['metadata'];
    } = {},
  ): ArtifactRef {
    this.#assertUnique(this.#artifacts, id, 'artifact');
    this.#artifacts.set(id, {
      id,
      paths: typeof paths === 'string' ? [paths] : [...paths],
      description: options.description ?? '',
      required: options.required ?? true,
      metadata: options.metadata ?? {},
    });
    return new ArtifactRef(id);
  }

  public capability<TCapabilityInput, TCapabilityOutput>(
    capability: CapabilityBinding<TCapabilityInput, TCapabilityOutput>,
    arguments_: InputBindings<TCapabilityInput>,
    options: NodeOptions,
  ): NodeRef<TCapabilityOutput> {
    this.#addNode(
      {
        id: options.id,
        kind: 'capability',
        ...(options.name === undefined ? {} : { name: options.name }),
        description: options.description ?? '',
        capabilityId: capability.definition.id,
        arguments: toBindings(arguments_),
        artifactInputs: options.artifactInputs?.map(({ id }) => id) ?? [],
        artifactOutputs: options.artifactOutputs?.map(({ id }) => id) ?? [],
      },
      options,
    );
    return new NodeRef(options.id);
  }

  public agent(agentId: string, prompt: Bindable<string>, options: NodeOptions): NodeRef<string> {
    this.#addNode(
      {
        id: options.id,
        kind: 'agent',
        ...(options.name === undefined ? {} : { name: options.name }),
        description: options.description ?? '',
        agentId,
        prompt: toBinding(prompt),
        artifactInputs: options.artifactInputs?.map(({ id }) => id) ?? [],
        artifactOutputs: options.artifactOutputs?.map(({ id }) => id) ?? [],
      },
      options,
    );
    return new NodeRef(options.id);
  }

  public subgraph<TNestedInput, TNestedOutput>(
    graph: TypedDagSpec<TNestedInput, TNestedOutput>,
    input: Bindable<TNestedInput>,
    options: NodeOptions,
  ): NodeRef<TNestedOutput> {
    this.#addNode(
      {
        id: options.id,
        kind: 'subgraph',
        ...(options.name === undefined ? {} : { name: options.name }),
        description: options.description ?? '',
        graph,
        input: toBinding(input),
        artifactInputs: options.artifactInputs?.map(({ id }) => id) ?? [],
        artifactOutputs: options.artifactOutputs?.map(({ id }) => id) ?? [],
      },
      options,
    );
    return new NodeRef(options.id);
  }

  public map<TItem, TNestedOutput>(
    items: Bindable<readonly TItem[]>,
    graph: TypedDagSpec<unknown, TNestedOutput>,
    options: NodeOptions & { readonly concurrency?: number; readonly maxItems?: number },
  ): NodeRef<readonly TNestedOutput[]> {
    this.#addNode(
      {
        id: options.id,
        kind: 'map',
        ...(options.name === undefined ? {} : { name: options.name }),
        description: options.description ?? '',
        items: toBinding(items),
        graph,
        concurrency: options.concurrency ?? 4,
        maxItems: options.maxItems ?? 1000,
        artifactInputs: options.artifactInputs?.map(({ id }) => id) ?? [],
        artifactOutputs: options.artifactOutputs?.map(({ id }) => id) ?? [],
      },
      options,
    );
    return new NodeRef(options.id);
  }

  public loop<TNestedInput, TNestedOutput>(
    graph: TypedDagSpec<TNestedInput, TNestedOutput>,
    input: Bindable<TNestedInput>,
    until: DagCondition,
    options: NodeOptions & { readonly maxIterations: number },
  ): NodeRef<TNestedOutput> {
    this.#addNode(
      {
        id: options.id,
        kind: 'loop',
        ...(options.name === undefined ? {} : { name: options.name }),
        description: options.description ?? '',
        graph,
        input: toBinding(input),
        until,
        maxIterations: options.maxIterations,
        artifactInputs: options.artifactInputs?.map(({ id }) => id) ?? [],
        artifactOutputs: options.artifactOutputs?.map(({ id }) => id) ?? [],
      },
      options,
    );
    return new NodeRef(options.id);
  }

  public condition(
    cases: readonly ConditionCase[],
    defaultBranch: string,
    options: ConditionNodeOptions,
  ): NodeRef<{ readonly branch: string }> {
    this.#addNode(
      {
        id: options.id,
        kind: 'condition',
        ...(options.name === undefined ? {} : { name: options.name }),
        description: options.description ?? '',
        cases,
        defaultBranch,
        artifactInputs: [],
        artifactOutputs: [],
      },
      options,
    );
    return new NodeRef(options.id);
  }

  public addEdge(
    from: NodeRef,
    to: NodeRef,
    conditionOrOptions?: DagCondition | EdgeOptions,
  ): this {
    const options =
      conditionOrOptions !== undefined && 'operator' in conditionOrOptions
        ? { condition: conditionOrOptions }
        : conditionOrOptions;
    this.#edges.push({
      from: from.id,
      to: to.id,
      ...(options?.condition === undefined ? {} : { condition: options.condition }),
      ...(options?.branch === undefined ? {} : { branch: options.branch }),
    });
    return this;
  }

  public setOutput(output: Bindable<TOutput>): this {
    this.#output = toBinding(output);
    return this;
  }

  public build(): TypedDagSpec<TInput, TOutput> {
    const candidate = dagSpecSchema.parse({
      schemaVersion: 1,
      id: this.#options.id,
      name: this.#options.name,
      description: this.#options.description ?? '',
      ...(this.#options.input === undefined
        ? {}
        : { inputSchema: z.toJSONSchema(this.#options.input) }),
      ...(this.#options.output === undefined
        ? {}
        : { outputSchema: z.toJSONSchema(this.#options.output) }),
      nodes: [...this.#nodes.values()],
      edges: this.#edges,
      artifacts: Object.fromEntries(this.#artifacts),
      ...(this.#output === undefined ? {} : { output: this.#output }),
    });
    return deepFreeze(assertValidDagInScope(candidate, this.#options.executionScope ?? 'root'));
  }

  #addNode(node: DagNode, options: NodeOptions): void {
    this.#assertUnique(this.#nodes, node.id, 'node');
    this.#nodes.set(node.id, node);
    for (const predecessor of options.after ?? []) {
      this.addEdge(predecessor, new NodeRef(node.id), options.when);
    }
  }

  #assertUnique(values: ReadonlyMap<string, unknown>, id: string, label: string): void {
    if (values.has(id)) {
      throw new TypeError(`Duplicate ${label} id '${id}'.`);
    }
  }
}

export type Bindable<T> =
  | T
  | ValueRef<T>
  | (T extends readonly (infer TItem)[] ? readonly Bindable<TItem>[] : never)
  | (T extends Record<string, unknown> ? { readonly [TKey in keyof T]: Bindable<T[TKey]> } : never);

export type InputBindings<T> =
  T extends Record<string, unknown> ? { readonly [TKey in keyof T]: Bindable<T[TKey]> } : never;

type PathKey<T> = Extract<keyof T, string | number>;

function toBindings(input: object): Record<string, ValueBinding> {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, toBinding(value as Bindable<unknown>)]),
  );
}

function toBinding<T>(input: Bindable<T>): ValueBinding {
  if (input instanceof ValueRef) return input.toBinding();
  if (Array.isArray(input)) return input.map((value) => toBinding(value as Bindable<unknown>));
  if (input !== null && typeof input === 'object') {
    return Object.fromEntries(
      Object.entries(input).map(([key, value]) => [key, toBinding(value as Bindable<unknown>)]),
    );
  }
  return input as ValueBinding;
}
