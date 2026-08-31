import type {
  ArtifactStates,
  ArtifactFileManifest,
  ArtifactUpload,
  CapabilityInvocation,
  ContentReference,
  DAGSpec,
  DagNode,
  DagNodeResult,
  JsonValue,
  ConversationState,
  PendingReview,
} from '../contracts/index.js';
import {
  createInvocationId,
  dagNodeResultSchema,
  jsonObjectSchema,
  nowTimestamp,
} from '../contracts/index.js';
import { DagentError, errorMessage, throwIfAborted } from '../errors.js';
import { evaluateCondition, resolveBinding } from '../domain/value-resolver.js';
import { assertValidDag } from '../domain/dag-validation.js';
import { validateDagInput } from '../domain/dag-input-validation.js';
import {
  externalizeJsonValue,
  normalizeCapabilityResult,
  readReferencedJsonValue,
} from './result-storage.js';
import { ArtifactWorkspace } from './artifacts.js';
import type { RuntimeExecutionContext } from './types.js';

export type AgentNodeInvoker = (
  nodeId: string,
  agentId: string,
  prompt: string,
  context: RuntimeExecutionContext,
) => Promise<AgentNodeOutcome>;

export type AgentNodeOutcome =
  | { readonly status: 'completed'; readonly output: JsonValue }
  | {
      readonly status: 'awaiting-review';
      readonly conversation: ConversationState;
      readonly review: PendingReview;
    };

export class StaticAgentReviewPause extends Error {
  public nodeResults: Readonly<Record<string, DagNodeResult>> = {};
  public artifactStates: ArtifactStates = {};

  public constructor(
    public readonly nodeId: string,
    public readonly agentId: string,
    public readonly conversation: ConversationState,
    public readonly review: PendingReview,
  ) {
    super(`Static agent node '${nodeId}' requires capability review.`);
    this.name = 'StaticAgentReviewPause';
  }
}

export type DagExecutionResult = {
  readonly output: JsonValue;
  readonly nodeResults: Readonly<Record<string, DagNodeResult>>;
  readonly artifactStates: ArtifactStates;
  /** Full values for the active execution; never persisted as checkpoint data. */
  readonly nodeValues: Readonly<Record<string, JsonValue>>;
};

type ExecutedNode = {
  readonly result: DagNodeResult;
  readonly value?: JsonValue;
};

export class DagExecutor {
  readonly #invokeAgent: AgentNodeInvoker;

  public constructor(invokeAgent: AgentNodeInvoker) {
    this.#invokeAgent = invokeAgent;
  }

  public async execute(
    graphInput: JsonValue,
    graphValue: DAGSpec,
    context: RuntimeExecutionContext,
    options: {
      readonly previousResults?: Readonly<Record<string, DagNodeResult>>;
      readonly previousArtifactStates?: ArtifactStates;
      readonly artifactUploads?: Readonly<Record<string, readonly ArtifactUpload[]>>;
      readonly inputArtifactFiles?: readonly ArtifactFileManifest[];
      readonly item?: JsonValue;
      readonly iteration?: number;
      readonly validated?: boolean;
    } = {},
  ): Promise<DagExecutionResult> {
    const graph = options.validated === true ? graphValue : assertValidDag(graphValue);
    validateDagInput(graph, graphInput);
    const results: Record<string, DagNodeResult> = { ...options.previousResults };
    const nodeValues = await restoreNodeValues(results, context.workspacePath);
    const artifacts = await ArtifactWorkspace.open({
      workspacePath: context.workspacePath,
      artifacts: graph.artifacts,
      ...(options.previousArtifactStates === undefined
        ? {}
        : { previousStates: options.previousArtifactStates }),
    });
    if (options.artifactUploads !== undefined) {
      await artifacts.materialize(options.artifactUploads);
    }
    const pending = new Set(
      graph.nodes.filter((node) => !isTerminal(results[node.id]?.status)).map((node) => node.id),
    );
    const predecessors = predecessorEdges(graph);

    while (pending.size > 0) {
      throwIfAborted(context.signal);
      const ready = graph.nodes.filter(
        (node) =>
          pending.has(node.id) &&
          (predecessors.get(node.id) ?? []).every((edge) => isTerminal(results[edge.from]?.status)),
      );
      if (ready.length === 0) {
        throw new DagentError('DAG_EXECUTION_FAILED', `DAG '${graph.id}' cannot make progress.`, {
          details: { pending: [...pending] },
        });
      }

      const readyAgent = ready.find(({ kind }) => kind === 'agent');
      const batch =
        readyAgent === undefined
          ? ready.slice(0, context.budget.limits.maxConcurrency)
          : [readyAgent];
      let completed: ExecutedNode[];
      try {
        completed = await Promise.all(
          batch.map(async (node) => {
            const incoming = predecessors.get(node.id) ?? [];
            const resolutionContext = {
              graphInput,
              nodeResults: results,
              nodeValues,
              graph,
              workspacePath: context.workspacePath,
              ...(options.inputArtifactFiles === undefined
                ? {}
                : { inputArtifactFiles: options.inputArtifactFiles }),
              ...(options.item === undefined ? {} : { item: options.item }),
              ...(options.iteration === undefined ? {} : { iteration: options.iteration }),
            };
            const shouldSkip =
              incoming.length > 0 &&
              incoming.every((edge) => !isLiveEdge(edge, results, resolutionContext));
            if (shouldSkip) {
              return {
                result: dagNodeResultSchema.parse({
                  nodeId: node.id,
                  status: 'skipped',
                  content: 'Conditional dependency was not satisfied.',
                  completedAt: nowTimestamp(),
                }),
              };
            }
            return this.#executeNode(
              node,
              graphInput,
              graph,
              results,
              nodeValues,
              context,
              options,
            );
          }),
        );
      } catch (error) {
        if (error instanceof StaticAgentReviewPause) {
          error.nodeResults = { ...results };
          error.artifactStates = artifacts.snapshot();
        }
        throw error;
      }
      for (const executed of completed) {
        const { result } = executed;
        results[result.nodeId] = result;
        if (executed.value !== undefined) nodeValues[result.nodeId] = executed.value;
        pending.delete(result.nodeId);
        const node = graph.nodes.find(({ id }) => id === result.nodeId);
        if (node !== undefined && result.status === 'completed') {
          await artifacts.refreshOutputs(node);
        }
        await context.events.emit({ type: 'node-completed', result });
      }
      const failure = completed
        .map(({ result }) => result)
        .find((result) => result.status === 'failed');
      if (failure !== undefined) {
        artifacts.markPlannedAsFailed(failure.error ?? failure.content);
        throw new DagentError(
          'DAG_EXECUTION_FAILED',
          `Node '${failure.nodeId}' failed: ${failure.error ?? failure.content}`,
          {
            details: {
              nodeId: failure.nodeId,
              results,
              artifactStates: artifacts.snapshot(),
            },
          },
        );
      }
    }

    const output =
      graph.output === undefined
        ? defaultGraphOutput(graph, results, nodeValues)
        : resolveBinding(graph.output, {
            graphInput,
            nodeResults: results,
            nodeValues,
            graph,
            workspacePath: context.workspacePath,
            ...(options.inputArtifactFiles === undefined
              ? {}
              : { inputArtifactFiles: options.inputArtifactFiles }),
            ...(options.item === undefined ? {} : { item: options.item }),
            ...(options.iteration === undefined ? {} : { iteration: options.iteration }),
          });
    try {
      artifacts.assertRequiredOutputs();
    } catch (error) {
      artifacts.markPlannedAsFailed(error);
      throw new DagentError('DAG_EXECUTION_FAILED', errorMessage(error), {
        cause: error,
        details: {
          results,
          artifactStates: artifacts.snapshot(),
        },
      });
    }
    return {
      output,
      nodeResults: results,
      artifactStates: artifacts.snapshot(),
      nodeValues,
    };
  }

  async #executeNode(
    node: DagNode,
    graphInput: JsonValue,
    graph: DAGSpec,
    results: Readonly<Record<string, DagNodeResult>>,
    nodeValues: Readonly<Record<string, JsonValue>>,
    context: RuntimeExecutionContext,
    options: {
      readonly item?: JsonValue;
      readonly iteration?: number;
      readonly inputArtifactFiles?: readonly ArtifactFileManifest[];
    },
  ): Promise<ExecutedNode> {
    context.budget.reserveNodeExecution(context.signal);
    const startedAt = nowTimestamp();
    await context.events.emit({ type: 'node-started', nodeId: node.id });
    const resolutionContext = {
      graphInput,
      nodeResults: results,
      nodeValues,
      graph,
      workspacePath: context.workspacePath,
      ...(options.inputArtifactFiles === undefined
        ? {}
        : { inputArtifactFiles: options.inputArtifactFiles }),
      ...(options.item === undefined ? {} : { item: options.item }),
      ...(options.iteration === undefined ? {} : { iteration: options.iteration }),
    };
    try {
      let output: JsonValue;
      let persistedOutput: JsonValue | undefined;
      let valueReference: ContentReference | undefined;
      let references: ContentReference[] = [];
      let content = '';
      let selectedBranch: string | undefined;
      switch (node.kind) {
        case 'capability': {
          const arguments_ = jsonObjectSchema.parse(
            resolveBinding(node.arguments, resolutionContext),
          );
          const invocation: CapabilityInvocation = {
            id: createInvocationId(),
            capabilityId: node.capabilityId,
            arguments: arguments_,
          };
          context.budget.reserveCapabilityCall(context.signal);
          await context.events.emit({ type: 'capability-started', invocation });
          const invoked = await context.catalog.invoke(
            node.capabilityId,
            arguments_,
            {
              runId: context.runId,
              workspacePath: context.workspacePath,
              signal: context.signal,
              metadata: { nodeId: node.id },
            },
            invocation.id,
          );
          const normalized = await normalizeCapabilityResult(invoked.result, {
            workspacePath: context.workspacePath,
            runtimeDirectory: context.runtimeDirectory,
            policy: context.resultStoragePolicy,
          });
          await context.events.emit({
            type: 'capability-completed',
            result: normalized.result,
          });
          if (normalized.result.status !== 'completed') {
            throw new DagentError(
              'CAPABILITY_FAILED',
              normalized.result.error ?? `Capability '${node.capabilityId}' failed.`,
            );
          }
          output =
            normalized.originalOutput ?? normalized.result.output ?? normalized.result.content;
          persistedOutput = normalized.result.output ?? normalized.result.content;
          valueReference = normalized.valueReference;
          references = [...normalized.references];
          content = normalized.result.content;
          break;
        }
        case 'agent': {
          const promptValue = resolveBinding(node.prompt, resolutionContext);
          const prompt =
            typeof promptValue === 'string' ? promptValue : JSON.stringify(promptValue);
          const invoked = await this.#invokeAgent(node.id, node.agentId, prompt, context);
          if (invoked.status === 'awaiting-review') {
            throw new StaticAgentReviewPause(
              node.id,
              node.agentId,
              invoked.conversation,
              invoked.review,
            );
          }
          output = invoked.output;
          content = typeof output === 'string' ? output : JSON.stringify(output);
          break;
        }
        case 'subgraph': {
          const nestedInput = resolveBinding(node.input, resolutionContext);
          const nested = await this.execute(nestedInput, node.graph, context, { validated: true });
          output = nested.output;
          content = typeof output === 'string' ? output : JSON.stringify(output);
          break;
        }
        case 'map': {
          const items = resolveBinding(node.items, resolutionContext);
          if (!Array.isArray(items)) {
            throw new DagentError(
              'DAG_EXECUTION_FAILED',
              `Map node '${node.id}' requires an array.`,
            );
          }
          if (items.length > node.maxItems) {
            throw new DagentError(
              'BUDGET_EXCEEDED',
              `Map node '${node.id}' received ${items.length} items; maxItems is ${node.maxItems}.`,
            );
          }
          output = await mapWithConcurrency(items, node.concurrency, async (item, index) => {
            const nested = await this.execute({ item, index }, node.graph, context, {
              item,
              validated: true,
            });
            return nested.output;
          });
          content = JSON.stringify(output);
          break;
        }
        case 'loop': {
          let loopInput = resolveBinding(node.input, resolutionContext);
          let lastOutput: JsonValue = loopInput;
          for (let iteration = 0; iteration < node.maxIterations; iteration += 1) {
            const nested = await this.execute(loopInput, node.graph, context, {
              item: lastOutput,
              iteration,
              validated: true,
            });
            lastOutput = nested.output;
            const until = evaluateCondition(node.until, {
              graphInput: loopInput,
              nodeResults: nested.nodeResults,
              nodeValues: nested.nodeValues,
              graph: node.graph,
              workspacePath: context.workspacePath,
              item: lastOutput,
              iteration,
            });
            if (until) {
              break;
            }
            loopInput = lastOutput;
          }
          output = lastOutput;
          content = typeof output === 'string' ? output : JSON.stringify(output);
          break;
        }
        case 'condition': {
          selectedBranch = node.defaultBranch;
          for (const conditionCase of node.cases) {
            if (evaluateCondition(conditionCase.when, resolutionContext)) {
              selectedBranch = conditionCase.branch;
              break;
            }
          }
          output = { branch: selectedBranch };
          content = JSON.stringify(output);
          break;
        }
      }
      if (persistedOutput === undefined) {
        const stored = await externalizeJsonValue(output, {
          workspacePath: context.workspacePath,
          runtimeDirectory: context.runtimeDirectory,
          key: `node-${node.id}-${createInvocationId()}`,
          policy: context.resultStoragePolicy,
        });
        persistedOutput = stored.value;
        valueReference = stored.reference;
        if (stored.reference !== undefined) {
          references = [stored.reference];
          content = stored.reference.preview;
        }
      }
      return {
        result: dagNodeResultSchema.parse({
          nodeId: node.id,
          status: 'completed',
          output: persistedOutput,
          ...(valueReference === undefined ? {} : { valueReference }),
          references,
          content,
          ...(selectedBranch === undefined ? {} : { selectedBranch }),
          startedAt,
          completedAt: nowTimestamp(),
        }),
        value: output,
      };
    } catch (error) {
      if (error instanceof StaticAgentReviewPause) throw error;
      return {
        result: dagNodeResultSchema.parse({
          nodeId: node.id,
          status: context.signal.aborted ? 'cancelled' : 'failed',
          content: '',
          error: errorMessage(error),
          startedAt,
          completedAt: nowTimestamp(),
        }),
      };
    }
  }
}

type DagEdge = DAGSpec['edges'][number];

function isLiveEdge(
  edge: DagEdge,
  results: Readonly<Record<string, DagNodeResult>>,
  context: Parameters<typeof evaluateCondition>[1],
): boolean {
  const source = results[edge.from];
  if (source?.status !== 'completed') return false;
  if (edge.branch !== undefined) return source.selectedBranch === edge.branch;
  return edge.condition === undefined || evaluateCondition(edge.condition, context);
}

function predecessorEdges(graph: DAGSpec): ReadonlyMap<string, readonly DagEdge[]> {
  const values = new Map<string, DagEdge[]>();
  for (const edge of graph.edges) {
    const edges = values.get(edge.to) ?? [];
    edges.push(edge);
    values.set(edge.to, edges);
  }
  return values;
}

function isTerminal(status: DagNodeResult['status'] | undefined): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'skipped' || status === 'cancelled'
  );
}

function defaultGraphOutput(
  graph: DAGSpec,
  results: Readonly<Record<string, DagNodeResult>>,
  nodeValues: Readonly<Record<string, JsonValue>>,
): JsonValue {
  const terminal = graph.nodes.filter((node) => !graph.edges.some((edge) => edge.from === node.id));
  if (terminal.length === 1) {
    const id = terminal[0]?.id ?? '';
    return nodeValues[id] ?? results[id]?.output ?? null;
  }
  return Object.fromEntries(
    terminal.map((node) => [node.id, nodeValues[node.id] ?? results[node.id]?.output ?? null]),
  );
}

async function restoreNodeValues(
  results: Readonly<Record<string, DagNodeResult>>,
  workspacePath: string,
): Promise<Record<string, JsonValue>> {
  const values: Record<string, JsonValue> = {};
  await Promise.all(
    Object.entries(results).map(async ([nodeId, result]) => {
      if (result.status !== 'completed' || result.output === undefined) return;
      values[nodeId] =
        result.valueReference === undefined
          ? result.output
          : await readReferencedJsonValue(result.valueReference, workspacePath);
    }),
  );
  return values;
}

async function mapWithConcurrency<TInput, TOutput>(
  values: readonly TInput[],
  concurrency: number,
  operation: (value: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  const output = new Array<TOutput>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      const value = values[index];
      if (value !== undefined) output[index] = await operation(value, index);
    }
  });
  await Promise.all(workers);
  return output;
}
