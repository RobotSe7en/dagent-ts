import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { z } from 'zod';

import { CapabilityCatalog } from './capabilities/catalog.js';
import type { CapabilityBinding } from './capabilities/tool.js';
import {
  appendConversationItems,
  assistantMessageSchema,
  artifactStatesSchema,
  conversationStateSchema,
  contextPolicySchema,
  createRunId,
  createReviewId,
  dagNodeResultSchema,
  executionLimitsSchema,
  extraSystemPromptSchema,
  nowTimestamp,
  pendingReviewSchema,
  resolvedRunPlanPayloadSchema,
  resolvedRunPlanSchema,
  resultStoragePolicySchema,
  runtimeDirectorySchema,
  reviewDecisionSchema,
  runCheckpointSchema,
  runStateSchema,
  runTargetSchema,
  validationPolicySchema,
  validationRecordSchema,
  formatValidationFeedback,
  storedContentText,
  defineDagAgent,
} from './contracts/index.js';
import type {
  AgentProfile,
  AutoAgent,
  ArtifactStates,
  ArtifactUpload,
  Attachment,
  ContextPolicy,
  ConversationState,
  DAGSpec,
  DagDesignEvent,
  DagDesignResult,
  DagDesignSelection,
  DagAgent,
  ExecutionLimits,
  JsonValue,
  ResolvedRunPlan,
  ResultStoragePolicy,
  ReviewDecision,
  RunCheckpoint,
  RunEvent,
  RunId,
  RunOutcome,
  RunState,
  RunTarget,
  ToolAgent,
  ValidationPolicy,
  ValidationRecord,
} from './contracts/index.js';
import { assertValidDag } from './domain/dag-validation.js';
import { validateDagInput } from './domain/dag-input-validation.js';
import { reusableNodeResults } from './domain/dag-transition.js';
import { DagentError, errorMessage } from './errors.js';
import { sha256 } from './internal/stable-json.js';
import { McpManager } from './mcp/index.js';
import type { McpServerConfig } from './mcp/index.js';
import type { ChatProvider } from './providers/provider.js';
import { ValidatorAgent } from './profiles/validator-agent.js';
import { AsyncEventQueue } from './runtime/async-event-queue.js';
import { ArtifactWorkspace } from './runtime/artifacts.js';
import { DagExecutor, StaticAgentReviewPause } from './runtime/dag-executor.js';
import { DynamicPlanner } from './runtime/dynamic-planner.js';
import { designDagRuntime, inspectDag } from './runtime/dag-design.js';
import {
  ConversationResourceStore,
  materializeInputUploads,
} from './runtime/conversation-resources.js';
import { RunEventEmitter } from './runtime/events.js';
import { ExecutionBudget } from './runtime/execution-budget.js';
import {
  assertGraphWithinPlan,
  graphRequiresRiskReview,
  plannerAgents,
  resolveExecutionScope,
  resolvedAgentsForPlan,
  validateResolvedExecutionScope,
} from './runtime/execution-scope.js';
import { ToolAgentRuntime } from './runtime/tool-agent.js';
import type { AgentLoopResult, RuntimeExecutionContext } from './runtime/types.js';
import { createSkillCapabilities, SkillStore } from './skills/index.js';
import { loadBuiltinProfile } from './profiles/store.js';

export type RunnerOptions = {
  readonly provider: ChatProvider;
  readonly capabilities?: readonly CapabilityBinding[];
  readonly agents?: readonly (ToolAgent | DagAgent | AutoAgent)[];
  readonly workspace?: string;
  readonly runtimeDirectory?: string;
  readonly extraSystemPrompt?: string;
  readonly limits?: Partial<ExecutionLimits>;
  readonly context?: Partial<ContextPolicy>;
  readonly resultStorage?: Partial<ResultStoragePolicy>;
  readonly contextWindowTokens?: number;
  readonly outputReserveTokens?: number;
  readonly validation?: {
    readonly enabled?: boolean;
    readonly maxRetries?: number;
    readonly profile?: AgentProfile;
  };
  readonly skillRoots?: readonly string[];
  readonly managedSkillRoot?: string;
};

export type AgentRunInput = {
  readonly prompt: string;
  readonly conversation?: ConversationState;
  readonly uploads?: readonly ArtifactUpload[];
};

export type StaticDagRunInput = {
  readonly graphInput?: JsonValue;
  readonly artifactUploads?: Readonly<Record<string, readonly ArtifactUpload[]>>;
};

export type RunInput = AgentRunInput | StaticDagRunInput;
type PreparedAgentRunInput = Omit<AgentRunInput, 'uploads'> & {
  readonly attachments: readonly Attachment[];
};
type PreparedRunInput = PreparedAgentRunInput | StaticDagRunInput;

export type RunOptions = {
  readonly workspacePath?: string;
  readonly workspaceRoot?: string;
  readonly signal?: AbortSignal;
  readonly limits?: Partial<ExecutionLimits>;
};

export type DagDesignOptions = {
  readonly agent?: DagAgent;
  readonly current?: DAGSpec;
  readonly selection?: DagDesignSelection;
  readonly conversation?: ConversationState;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: DagDesignEvent) => void | Promise<void>;
};

export class Runner implements AsyncDisposable {
  public readonly catalog: CapabilityCatalog;
  public readonly skills: SkillStore;
  public readonly mcp: McpManager;
  readonly #provider: ChatProvider;
  readonly #agents = new Map<string, ToolAgent | DagAgent | AutoAgent>();
  readonly #workspace: string;
  readonly #runtimeDirectory: string;
  #extraSystemPrompt: string | undefined;
  readonly #conversationResources: ConversationResourceStore;
  readonly #limits: ExecutionLimits;
  readonly #context: ContextPolicy;
  readonly #resultStorage: ResultStoragePolicy;
  readonly #contextWindowTokens: number | undefined;
  readonly #outputReserveTokens: number | undefined;
  #validation: ValidationPolicy;
  readonly #checkpoints = new Map<RunId, RunCheckpoint>();
  readonly #active = new Map<RunId, AbortController>();
  readonly #consumedReviews = new Set<string>();
  #closed = false;

  public constructor(options: RunnerOptions) {
    this.#provider = options.provider;
    this.skills = new SkillStore({
      ...(options.skillRoots === undefined ? {} : { roots: options.skillRoots }),
      ...(options.managedSkillRoot === undefined ? {} : { managedRoot: options.managedSkillRoot }),
    });
    this.mcp = new McpManager();
    this.catalog = new CapabilityCatalog(createSkillCapabilities(this.skills));
    for (const binding of options.capabilities ?? []) this.catalog.replace(binding);
    this.#workspace = resolve(options.workspace ?? join(homedir(), '.dagent'));
    this.#runtimeDirectory = runtimeDirectorySchema.parse(options.runtimeDirectory ?? '.runtime');
    this.#extraSystemPrompt =
      options.extraSystemPrompt === undefined
        ? undefined
        : extraSystemPromptSchema.parse(options.extraSystemPrompt);
    this.#conversationResources = new ConversationResourceStore(
      this.#workspace,
      this.#runtimeDirectory,
    );
    this.#limits = executionLimitsSchema.parse(options.limits ?? {});
    this.#context = contextPolicySchema.parse(options.context ?? {});
    this.#resultStorage = resultStoragePolicySchema.parse(options.resultStorage ?? {});
    this.#contextWindowTokens = options.contextWindowTokens;
    this.#outputReserveTokens = options.outputReserveTokens;
    this.#validation = validationPolicySchema.parse(options.validation ?? {});
    for (const agent of options.agents ?? []) this.registerAgent(agent);
  }

  public get workspacePath(): string {
    return this.#workspace;
  }

  public get runtimeDirectory(): string {
    return this.#runtimeDirectory;
  }

  public get extraSystemPrompt(): string | undefined {
    return this.#extraSystemPrompt;
  }

  public set extraSystemPrompt(value: string | undefined) {
    this.#assertOpen();
    this.#extraSystemPrompt =
      value === undefined ? undefined : extraSystemPromptSchema.parse(value);
  }

  public get validationPolicy(): ValidationPolicy {
    return this.#validation;
  }

  public setValidationEnabled(enabled: boolean): ValidationPolicy {
    this.#assertOpen();
    this.#validation = validationPolicySchema.parse({
      ...this.#validation,
      enabled,
    });
    return this.#validation;
  }

  public registerCapability(binding: CapabilityBinding): void {
    this.#assertOpen();
    this.catalog.register(binding);
  }

  public async connectMcp(config: McpServerConfig): Promise<readonly CapabilityBinding[]> {
    this.#assertOpen();
    const bindings = await this.mcp.connect(config);
    const registered: string[] = [];
    try {
      const ids = new Set<string>();
      const collision = bindings.find(({ definition }) => {
        if (ids.has(definition.id) || this.catalog.get(definition.id) !== undefined) return true;
        ids.add(definition.id);
        return false;
      });
      if (collision !== undefined) {
        throw new DagentError(
          'INVALID_INPUT',
          `MCP capability '${collision.definition.id}' is already registered.`,
        );
      }
      for (const binding of bindings) {
        this.catalog.register(binding);
        registered.push(binding.definition.id);
      }
      return bindings;
    } catch (error) {
      for (const id of registered) this.catalog.unregister(id);
      await this.mcp.disconnect(config.name).catch(() => undefined);
      throw error;
    }
  }

  public async disconnectMcp(name: string): Promise<boolean> {
    this.#assertOpen();
    const connected = this.mcp.list().find(({ config }) => config.name === name);
    if (connected === undefined) return false;
    try {
      return await this.mcp.disconnect(name);
    } finally {
      for (const binding of connected.capabilities) {
        this.catalog.unregister(binding.definition.id);
      }
    }
  }

  public registerAgent(agent: ToolAgent | DagAgent | AutoAgent): void {
    this.#assertOpen();
    const parsed = parseAgent(agent);
    if (this.#agents.has(parsed.id)) {
      throw new DagentError('INVALID_INPUT', `Agent '${parsed.id}' is already registered.`);
    }
    this.#agents.set(parsed.id, parsed);
  }

  public replaceAgent(agent: ToolAgent | DagAgent | AutoAgent): void {
    this.#assertOpen();
    const parsed = parseAgent(agent);
    this.#agents.set(parsed.id, parsed);
  }

  public unregisterAgent(id: string): boolean {
    this.#assertOpen();
    return this.#agents.delete(id);
  }

  public agent(id: string): ToolAgent | DagAgent | AutoAgent | undefined {
    return this.#agents.get(id);
  }

  public agents(): readonly (ToolAgent | DagAgent | AutoAgent)[] {
    return [...this.#agents.values()];
  }

  public checkpoint(runId: RunId): RunCheckpoint | undefined {
    return this.#checkpoints.get(runId);
  }

  public cancel(runId: RunId, reason = 'Cancelled by caller.'): boolean {
    const controller = this.#active.get(runId);
    if (controller === undefined) return false;
    controller.abort(new DagentError('ABORTED', reason));
    return true;
  }

  public inspectDag(spec: DAGSpec): readonly ReturnType<typeof inspectDag>[number][] {
    return inspectDag(spec);
  }

  public async designDag(
    instruction: string,
    options: DagDesignOptions = {},
  ): Promise<DagDesignResult> {
    this.#assertOpen();
    const agent =
      options.agent ??
      defineDagAgent({
        kind: 'dag-agent',
        id: 'dag_design',
        name: 'DAG Design',
        description: 'Non-executing DAG design.',
        systemPrompt: (await loadBuiltinProfile('dag_design')).content,
        scope: {
          capabilities: this.catalog
            .definitions()
            .filter(({ enabled }) => enabled)
            .map(({ id }) => id),
          agents: [...this.#agents.values()]
            .filter((candidate): candidate is ToolAgent => candidate.kind === 'tool-agent')
            .map(({ id }) => id),
        },
        reviewLevel: 'never',
      });
    return designDagRuntime({
      provider: this.#provider,
      catalog: this.catalog,
      registeredAgents: new Map(
        [...this.#agents.entries()].flatMap(([id, candidate]) =>
          candidate.kind === 'tool-agent' ? [[id, candidate] as const] : [],
        ),
      ),
      agent,
      instruction,
      contextWindowTokens:
        this.#contextWindowTokens ??
        readProviderNumber(this.#provider, 'contextWindowTokens', 32_768),
      outputReserveTokens:
        this.#outputReserveTokens ??
        readProviderNumber(this.#provider, 'outputReserveTokens', 4096),
      ...(options.current === undefined ? {} : { current: options.current }),
      ...(options.selection === undefined ? {} : { selection: options.selection }),
      ...(options.conversation === undefined ? {} : { conversation: options.conversation }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
      ...(this.#extraSystemPrompt === undefined
        ? {}
        : { extraSystemPrompt: this.#extraSystemPrompt }),
    });
  }

  public async run(
    targetValue: RunTarget,
    input: RunInput,
    options: RunOptions = {},
  ): Promise<RunOutcome> {
    return this.#start(targetValue, input, options);
  }

  public stream(
    targetValue: RunTarget,
    input: RunInput,
    options: RunOptions = {},
  ): AsyncIterable<RunEvent> {
    const queue = new AsyncEventQueue<RunEvent>();
    void this.#start(targetValue, input, options, (event) => {
      queue.push(event);
    })
      .then(() => {
        queue.close();
      })
      .catch((error: unknown) => {
        queue.fail(error);
      });
    return queue;
  }

  public async resume(
    checkpointValue: RunCheckpoint,
    decisionValue: ReviewDecision,
    options: Omit<RunOptions, 'workspacePath' | 'limits'> = {},
  ): Promise<RunOutcome> {
    return this.#resume(checkpointValue, decisionValue, options);
  }

  public resumeStream(
    checkpointValue: RunCheckpoint,
    decisionValue: ReviewDecision,
    options: Omit<RunOptions, 'workspacePath' | 'limits'> = {},
  ): AsyncIterable<RunEvent> {
    const queue = new AsyncEventQueue<RunEvent>();
    void this.#resume(checkpointValue, decisionValue, options, (event) => {
      queue.push(event);
    })
      .then(() => {
        queue.close();
      })
      .catch((error: unknown) => {
        queue.fail(error);
      });
    return queue;
  }

  async #resume(
    checkpointValue: RunCheckpoint,
    decisionValue: ReviewDecision,
    options: Omit<RunOptions, 'workspacePath' | 'limits'>,
    listener?: (event: RunEvent) => void | Promise<void>,
  ): Promise<RunOutcome> {
    this.#assertOpen();
    const checkpoint = await validateCheckpoint(
      checkpointValue,
      this.catalog,
      this.#agents,
      this.skills,
    );
    const decision = reviewDecisionSchema.parse(decisionValue);
    const review = checkpoint.state.pendingReview;
    if (review === undefined) {
      throw new DagentError('CHECKPOINT_MISMATCH', 'Checkpoint is not awaiting review.');
    }
    if (review.id !== decision.reviewId || review.revision !== decision.revision) {
      throw new DagentError('STALE_REVIEW', 'Review decision does not match checkpoint revision.');
    }
    const reviewKey = `${checkpoint.state.runId}:${review.id}:${review.revision}`;
    if (this.#consumedReviews.has(reviewKey)) {
      throw new DagentError(
        'STALE_REVIEW',
        `Checkpoint review '${review.id}' has already been consumed.`,
      );
    }
    this.#consumedReviews.add(reviewKey);
    const target = runTargetSchema.parse(checkpoint.plan.target);
    const controller = new AbortController();
    const signal =
      options.signal === undefined
        ? controller.signal
        : AbortSignal.any([controller.signal, options.signal]);
    this.#active.set(checkpoint.state.runId, controller);
    const emitter = new RunEventEmitter(checkpoint.state.runId, listener);
    const budget = new ExecutionBudget(checkpoint.plan.limits, checkpoint.usage);
    const context = this.#runtimeContext(
      checkpoint.state.runId,
      checkpoint.state.workspacePath,
      signal,
      emitter,
      budget,
      checkpoint.plan,
    );
    let failureState = checkpoint.state;
    try {
      if (decision.action === 'reject' && review.kind === 'dag-review') {
        const state = runStateSchema.parse({
          ...checkpoint.state,
          status: 'cancelled',
          pendingReview: undefined,
          error: decision.reason || 'DAG execution was rejected.',
          revision: checkpoint.state.revision + 1,
          updatedAt: nowTimestamp(),
        });
        return this.#finalize(state, checkpoint.plan, budget, emitter);
      }
      if (review.kind === 'capability-review') {
        if (review.invocation === undefined) {
          throw new DagentError(
            'CHECKPOINT_MISMATCH',
            'Capability review has no pending invocation.',
          );
        }
        if (target.kind === 'static-dag') {
          return this.#resumeStaticAgent(checkpoint.state, checkpoint.plan, decision, context);
        }
        const agent = capabilityResumeAgent(target);
        const runtime = new ToolAgentRuntime();
        let result: AgentLoopResult;
        try {
          result = await runtime.run(
            agent,
            {
              ...(checkpoint.state.conversation === undefined
                ? {}
                : { conversation: checkpoint.state.conversation }),
            },
            context,
            { invocation: review.invocation, decision, review },
          );
        } catch (error) {
          if (runtime.lastConversation !== undefined) {
            failureState = runStateSchema.parse({
              ...checkpoint.state,
              status: 'running',
              conversation: runtime.lastConversation,
              contextUsage: [...checkpoint.state.contextUsage, ...runtime.lastContextUsage],
              pendingReview: undefined,
              revision: checkpoint.state.revision + 1,
              updatedAt: nowTimestamp(),
            });
          }
          throw error;
        }
        failureState = runStateSchema.parse({
          ...checkpoint.state,
          status: 'running',
          conversation: result.conversation,
          contextUsage: [...checkpoint.state.contextUsage, ...result.contextUsage],
          pendingReview: undefined,
          revision: checkpoint.state.revision + 1,
          updatedAt: nowTimestamp(),
        });
        return this.#continueToolAgent(
          agent,
          lastUserRequest(result.conversation),
          result,
          checkpoint.state,
          checkpoint.plan,
          context,
        );
      }
      const graph = assertValidDag(
        decision.replacementGraph ?? review.proposedGraph ?? checkpoint.state.graph,
      );
      assertGraphWithinPlan(graph, checkpoint.plan);
      const reviewedGraph = review.proposedGraph ?? checkpoint.state.graph;
      const nodeResults =
        decision.replacementGraph === undefined || reviewedGraph === undefined
          ? checkpoint.state.nodeResults
          : reusableNodeResults(reviewedGraph, graph, checkpoint.state.nodeResults, []);
      const approvedState = runStateSchema.parse({
        ...checkpoint.state,
        status: 'running',
        graph,
        nodeResults,
        pendingReview: undefined,
        revision: checkpoint.state.revision + 1,
        updatedAt: nowTimestamp(),
      });
      try {
        return await this.#executeApprovedGraph(
          approvedState,
          checkpoint.plan,
          budget,
          emitter,
          context,
          graph,
        );
      } catch (error) {
        const dynamicAgent = dynamicAgentForTarget(target);
        if (dynamicAgent === undefined || context.signal.aborted) throw error;
        return this.#replanAfterReviewedFailure(
          dynamicAgent,
          lastUserRequest(
            checkpoint.state.conversation ?? conversationStateSchema.parse({ schemaVersion: 3 }),
          ),
          graph,
          error,
          approvedState,
          checkpoint.plan,
          context,
        );
      }
    } catch (error) {
      return this.#failedOutcome(failureState, checkpoint.plan, budget, emitter, error, signal);
    } finally {
      this.#active.delete(checkpoint.state.runId);
    }
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    for (const controller of this.#active.values()) {
      controller.abort(new DagentError('ABORTED', 'Runner is closing.'));
    }
    this.#active.clear();
    await this.mcp.close();
    this.#closed = true;
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  async #start(
    targetValue: RunTarget,
    input: RunInput,
    options: RunOptions,
    listener?: (event: RunEvent) => void | Promise<void>,
  ): Promise<RunOutcome> {
    this.#assertOpen();
    const target = runTargetSchema.parse(targetValue);
    if (isAgentInput(input)) assertAgentHistory(input);
    if (target.kind === 'static-dag') {
      assertValidDag(target.graph);
      assertStaticAgentTopology(target.graph);
      validateDagInput(target.graph, isAgentInput(input) ? {} : (input.graphInput ?? {}));
    }
    const runId = createRunId();
    const controller = new AbortController();
    const signal =
      options.signal === undefined
        ? controller.signal
        : AbortSignal.any([controller.signal, options.signal]);
    this.#active.set(runId, controller);
    try {
      const workspacePath = resolve(
        options.workspacePath ?? options.workspaceRoot ?? this.#workspace,
        options.workspacePath !== undefined
          ? ''
          : options.workspaceRoot === undefined
            ? `runs/${runId}`
            : `${runId}/workspace`,
      );
      await mkdir(workspacePath, { recursive: true });
      const preparedInput: PreparedRunInput = isAgentInput(input)
        ? await this.#prepareAgentInput(input, workspacePath)
        : input;
      const emitter = new RunEventEmitter(runId, listener);
      const limits = executionLimitsSchema.parse({ ...this.#limits, ...options.limits });
      const budget = new ExecutionBudget(limits);
      const plan = await createResolvedPlan(
        target,
        this.catalog,
        this.#agents,
        this.skills,
        limits,
        this.#contextForTarget(target),
        this.#resultStorage,
        this.#runtimeDirectory,
        this.#contextWindowTokens ??
          readProviderNumber(this.#provider, 'contextWindowTokens', 32_768),
        this.#outputReserveTokens ??
          readProviderNumber(this.#provider, 'outputReserveTokens', 4096),
        this.#validation,
        this.#extraSystemPrompt,
      );
      const timestamp = nowTimestamp();
      const initialState = runStateSchema.parse({
        schemaVersion: 4,
        runId,
        status: 'pending',
        targetKind: target.kind,
        ...(isAgentInput(preparedInput) && preparedInput.conversation !== undefined
          ? { conversation: preparedInput.conversation }
          : {}),
        graphInput: isAgentInput(preparedInput) ? {} : (preparedInput.graphInput ?? {}),
        nodeResults: {},
        workspacePath,
        revision: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
        contextUsage: [],
      });
      const context = this.#runtimeContext(runId, workspacePath, signal, emitter, budget, plan);
      try {
        await emitter.emit({ type: 'run-started' });
        const outcome = await this.#dispatch(target, preparedInput, initialState, plan, context);
        return outcome;
      } catch (error) {
        return this.#failedOutcome(initialState, plan, budget, emitter, error, signal);
      }
    } finally {
      this.#active.delete(runId);
    }
  }

  async #dispatch(
    target: RunTarget,
    input: PreparedRunInput,
    state: RunState,
    plan: ResolvedRunPlan,
    context: RuntimeExecutionContext,
  ): Promise<RunOutcome> {
    switch (target.kind) {
      case 'tool-agent': {
        const agentInput = requireAgentInput(input);
        const result = await new ToolAgentRuntime().run(
          target,
          {
            prompt: agentInput.prompt,
            ...(agentInput.conversation === undefined
              ? {}
              : { conversation: agentInput.conversation }),
            attachments: agentInput.attachments,
          },
          context,
        );
        return this.#continueToolAgent(target, agentInput.prompt, result, state, plan, context);
      }
      case 'dag-agent':
        return this.#runDynamic(target, requireAgentInput(input), state, plan, context);
      case 'auto-agent': {
        const route = await this.#route(target, requireAgentInput(input), context);
        const toolAgent = inheritAutoScope(target.toolAgent, target);
        const dagAgent = inheritAutoScope(target.dagAgent, target);
        return route === 'tool'
          ? this.#dispatch(toolAgent, input, state, plan, context)
          : this.#runDynamic(dagAgent, requireAgentInput(input), state, plan, context);
      }
      case 'static-dag': {
        const graphInput = isAgentInput(input) ? {} : (input.graphInput ?? {});
        const artifacts = await ArtifactWorkspace.open({
          workspacePath: state.workspacePath,
          artifacts: target.graph.artifacts,
          previousStates: state.artifactStates,
        });
        const inputArtifactFiles =
          !isAgentInput(input) && input.artifactUploads !== undefined
            ? await artifacts.materialize(input.artifactUploads)
            : [];
        const prepared = runStateSchema.parse({
          ...state,
          graph: target.graph,
          graphInput,
          artifactStates: artifacts.snapshot(),
          inputArtifactFiles,
          revision: state.revision + 1,
          updatedAt: nowTimestamp(),
        });
        if (requiresDagReview(target.reviewLevel, target.graph, this.catalog, this.#agents)) {
          return this.#awaitDagReview(prepared, plan, context, target.graph, 'Review static DAG');
        }
        const executing = runStateSchema.parse({
          ...prepared,
          status: 'running',
          revision: prepared.revision + 1,
          updatedAt: nowTimestamp(),
        });
        return this.#executeApprovedGraph(
          executing,
          plan,
          context.budget,
          context.events,
          context,
          target.graph,
        );
      }
    }
  }

  async #runDynamic(
    agent: DagAgent,
    input: PreparedAgentRunInput,
    state: RunState,
    plan: ResolvedRunPlan,
    context: RuntimeExecutionContext,
  ): Promise<RunOutcome> {
    const planner = new DynamicPlanner();
    let planned = await planner.plan(
      agent,
      {
        prompt: input.prompt,
        ...(input.conversation === undefined ? {} : { conversation: input.conversation }),
        ...(isPreparedAgentInput(input) ? { attachments: input.attachments } : {}),
      },
      context,
      plannerAgents(agent, plan, this.#agents),
    );
    let currentState = state;
    let completedResults: RunState['nodeResults'] = {};
    const usages = [...state.contextUsage, ...planned.contextUsage];
    for (let attempt = 0; attempt <= agent.maxReplans; attempt += 1) {
      const plannedState = runStateSchema.parse({
        ...currentState,
        status: 'planning',
        conversation: planned.conversation,
        contextUsage: usages,
        graph: planned.proposal.graph,
        graphInput: { prompt: input.prompt },
        nodeResults: completedResults,
        revision: currentState.revision + 1,
        updatedAt: nowTimestamp(),
      });
      if (
        requiresDagReview(agent.reviewLevel, planned.proposal.graph, this.catalog, this.#agents)
      ) {
        return this.#awaitDagReview(
          plannedState,
          plan,
          context,
          planned.proposal.graph,
          planned.proposal.rationale || 'Review dynamic DAG',
          planned.proposal.rerunNodeIds,
        );
      }
      try {
        return await this.#executeApprovedGraph(
          plannedState,
          plan,
          context.budget,
          context.events,
          context,
          planned.proposal.graph,
        );
      } catch (error) {
        if (attempt >= agent.maxReplans || context.signal.aborted) throw error;
        completedResults = completedNodeResults(error);
        currentState = partialRunState(error, state.runId) ?? plannedState;
        const previousGraph = planned.proposal.graph;
        const nextPlan = await planner.plan(
          agent,
          {
            prompt: input.prompt,
            conversation: planned.conversation,
            previousGraph: planned.proposal.graph,
            failure: errorMessage(error),
            completedNodeIds: Object.keys(completedResults),
          },
          context,
          plannerAgents(agent, plan, this.#agents),
        );
        completedResults = reusableNodeResults(
          previousGraph,
          nextPlan.proposal.graph,
          completedResults,
          nextPlan.proposal.rerunNodeIds,
        );
        planned = nextPlan;
        usages.push(...planned.contextUsage);
      }
    }
    throw new DagentError('DAG_EXECUTION_FAILED', 'Dynamic DAG exhausted replans.');
  }

  async #executeApprovedGraph(
    state: RunState,
    plan: ResolvedRunPlan,
    budget: ExecutionBudget,
    emitter: RunEventEmitter,
    context: RuntimeExecutionContext,
    graph: DAGSpec,
  ): Promise<RunOutcome> {
    assertGraphWithinPlan(graph, plan);
    const executionAgents = resolvedAgentsForPlan(plan, this.#agents);
    const executor = new DagExecutor(async (_nodeId, agentId, prompt, nestedContext) => {
      const agent = executionAgents.get(agentId);
      if (agent === undefined) {
        throw new DagentError(
          'CHECKPOINT_MISMATCH',
          `Agent '${agentId}' is outside the resolved execution scope.`,
        );
      }
      const result = await new ToolAgentRuntime().run(
        state.targetKind === 'static-dag' ? agent : { ...agent, reviewLevel: 'never' },
        { prompt },
        nestedContext,
      );
      if (result.status === 'awaiting-review') {
        if (state.targetKind !== 'static-dag') {
          throw new DagentError(
            'CHECKPOINT_MISMATCH',
            `Approved nested agent '${agentId}' unexpectedly requested review.`,
          );
        }
        return {
          status: 'awaiting-review' as const,
          conversation: result.conversation,
          review: result.review,
        };
      }
      return { status: 'completed' as const, output: result.output };
    });
    let result: Awaited<ReturnType<DagExecutor['execute']>>;
    try {
      result = await executor.execute(state.graphInput, graph, context, {
        previousResults: state.nodeResults,
        previousArtifactStates: state.artifactStates,
        inputArtifactFiles: state.inputArtifactFiles,
      });
    } catch (error) {
      if (error instanceof StaticAgentReviewPause) {
        return this.#staticAgentReviewOutcome(state, plan, budget, emitter, error);
      }
      const details = error instanceof DagentError ? error.details : {};
      const partialState = runStateSchema.parse({
        ...state,
        status: 'failed',
        graph,
        nodeResults: allNodeResults(error, state.nodeResults),
        artifactStates: artifactStatesFromError(error, state.artifactStates),
        error: errorMessage(error),
        pendingReview: undefined,
        revision: state.revision + 1,
        updatedAt: nowTimestamp(),
      });
      throw new DagentError(
        error instanceof DagentError ? error.code : 'DAG_EXECUTION_FAILED',
        errorMessage(error),
        {
          cause: error,
          details: { ...details, partialState },
        },
      );
    }
    let conversation = state.conversation;
    if (conversation !== undefined) {
      const assistant = assistantMessageSchema.parse({
        type: 'assistant',
        runId: state.runId,
        content: typeof result.output === 'string' ? result.output : JSON.stringify(result.output),
        scope: 'conversation',
        visibility: 'user',
      });
      conversation = appendConversationItems(conversation, assistant);
    }
    const completed = runStateSchema.parse({
      ...state,
      status: 'completed',
      graph,
      nodeResults: result.nodeResults,
      artifactStates: result.artifactStates,
      output: result.output,
      ...(conversation === undefined ? {} : { conversation }),
      pendingReview: undefined,
      revision: state.revision + 1,
      updatedAt: nowTimestamp(),
    });
    return this.#finalize(completed, plan, budget, emitter);
  }

  async #resumeStaticAgent(
    state: RunState,
    plan: ResolvedRunPlan,
    decision: ReviewDecision,
    context: RuntimeExecutionContext,
  ): Promise<RunOutcome> {
    const continuation = state.staticAgentContinuation;
    const review = state.pendingReview;
    if (
      continuation === undefined ||
      review?.kind !== 'capability-review' ||
      review.invocation === undefined
    ) {
      throw new DagentError(
        'CHECKPOINT_MISMATCH',
        'Static DAG capability review has no valid agent continuation.',
      );
    }
    const agent = resolvedAgentsForPlan(plan, this.#agents).get(continuation.agentId);
    if (agent === undefined) {
      throw new DagentError(
        'CHECKPOINT_MISMATCH',
        `Static DAG agent '${continuation.agentId}' is unavailable.`,
      );
    }
    const result = await new ToolAgentRuntime().run(
      agent,
      { conversation: continuation.conversation },
      context,
      { invocation: review.invocation, decision, review },
    );
    const resumedState = runStateSchema.parse({
      ...state,
      status: 'running',
      contextUsage: [...state.contextUsage, ...result.contextUsage],
      pendingReview: undefined,
      staticAgentContinuation: undefined,
      revision: state.revision + 1,
      updatedAt: nowTimestamp(),
    });
    if (result.status === 'awaiting-review') {
      return this.#staticAgentReviewOutcome(
        resumedState,
        plan,
        context.budget,
        context.events,
        new StaticAgentReviewPause(
          continuation.nodeId,
          continuation.agentId,
          result.conversation,
          result.review,
        ),
      );
    }
    const nodeResult = dagNodeResultSchema.parse({
      nodeId: continuation.nodeId,
      status: 'completed',
      output: result.output,
      content: result.output,
      completedAt: nowTimestamp(),
    });
    const executing = runStateSchema.parse({
      ...resumedState,
      nodeResults: { ...resumedState.nodeResults, [continuation.nodeId]: nodeResult },
    });
    await context.events.emit({ type: 'node-completed', result: nodeResult });
    if (executing.graph === undefined) {
      throw new DagentError('CHECKPOINT_MISMATCH', 'Static DAG continuation has no graph.');
    }
    return this.#executeApprovedGraph(
      executing,
      plan,
      context.budget,
      context.events,
      context,
      executing.graph,
    );
  }

  async #staticAgentReviewOutcome(
    state: RunState,
    plan: ResolvedRunPlan,
    budget: ExecutionBudget,
    emitter: RunEventEmitter,
    pause: StaticAgentReviewPause,
  ): Promise<RunOutcome> {
    const invocation = pause.review.invocation;
    if (invocation === undefined) {
      throw new DagentError(
        'CHECKPOINT_MISMATCH',
        'Static agent review does not contain a pending invocation.',
      );
    }
    const awaiting = runStateSchema.parse({
      ...state,
      status: 'awaiting-review',
      nodeResults:
        Object.keys(pause.nodeResults).length === 0 ? state.nodeResults : pause.nodeResults,
      artifactStates:
        Object.keys(pause.artifactStates).length === 0
          ? state.artifactStates
          : pause.artifactStates,
      pendingReview: pause.review,
      staticAgentContinuation: {
        nodeId: pause.nodeId,
        agentId: pause.agentId,
        invocation,
        conversation: pause.conversation,
        graphInput: state.graphInput,
      },
      revision: state.revision + 1,
      updatedAt: nowTimestamp(),
    });
    return this.#finalize(awaiting, plan, budget, emitter);
  }

  async #replanAfterReviewedFailure(
    agent: DagAgent,
    prompt: string,
    failedGraph: DAGSpec,
    initialError: unknown,
    reviewState: RunState,
    plan: ResolvedRunPlan,
    context: RuntimeExecutionContext,
  ): Promise<RunOutcome> {
    const planner = new DynamicPlanner();
    const priorConversationRevision = reviewState.conversation?.revision ?? 0;
    let graph = failedGraph;
    let error = initialError;
    let state = partialRunState(initialError, reviewState.runId) ?? reviewState;
    let completedResults = completedNodeResults(initialError);
    const usedReplans = Math.max(
      0,
      plannerTurnCount(reviewState.conversation, reviewState.runId) - 1,
    );

    for (let attempt = usedReplans; attempt < agent.maxReplans; attempt += 1) {
      const planned = await planner.plan(
        agent,
        {
          prompt,
          ...(state.conversation === undefined ? {} : { conversation: state.conversation }),
          previousGraph: graph,
          failure: errorMessage(error),
          completedNodeIds: Object.keys(completedResults),
        },
        context,
        plannerAgents(agent, plan, this.#agents),
      );
      completedResults = reusableNodeResults(
        graph,
        planned.proposal.graph,
        completedResults,
        planned.proposal.rerunNodeIds,
      );
      let conversation = planned.conversation;
      if (conversation.revision <= priorConversationRevision) {
        conversation = conversationStateSchema.parse({
          ...conversation,
          revision: priorConversationRevision + 1,
        });
      }
      const plannedState = runStateSchema.parse({
        ...state,
        status: 'planning',
        conversation,
        contextUsage: [...state.contextUsage, ...planned.contextUsage],
        graph: planned.proposal.graph,
        nodeResults: completedResults,
        error: undefined,
        pendingReview: undefined,
        revision: state.revision + 1,
        updatedAt: nowTimestamp(),
      });
      if (
        requiresDagReview(agent.reviewLevel, planned.proposal.graph, this.catalog, this.#agents)
      ) {
        return this.#awaitDagReview(
          plannedState,
          plan,
          context,
          planned.proposal.graph,
          planned.proposal.rationale || 'Review proposed DAG revision from replanning.',
          planned.proposal.rerunNodeIds,
        );
      }
      try {
        return await this.#executeApprovedGraph(
          plannedState,
          plan,
          context.budget,
          context.events,
          context,
          planned.proposal.graph,
        );
      } catch (nextError) {
        graph = planned.proposal.graph;
        error = nextError;
        state = partialRunState(nextError, reviewState.runId) ?? plannedState;
        completedResults = completedNodeResults(nextError);
      }
    }
    throw error;
  }

  async #awaitDagReview(
    state: RunState,
    plan: ResolvedRunPlan,
    context: RuntimeExecutionContext,
    graph: DAGSpec,
    summary: string,
    rerunNodeIds: readonly string[] = [],
  ): Promise<RunOutcome> {
    const review = pendingReviewSchema.parse({
      id: createReviewId(),
      revision: state.revision + 1,
      kind: 'dag-review',
      summary,
      proposedGraph: graph,
      rerunNodeIds,
      createdAt: nowTimestamp(),
    });
    await context.events.emit({ type: 'review-required', review });
    const awaiting = runStateSchema.parse({
      ...state,
      status: 'awaiting-review',
      graph,
      pendingReview: review,
      revision: review.revision,
      updatedAt: nowTimestamp(),
    });
    return this.#finalize(awaiting, plan, context.budget, context.events);
  }

  async #agentLoopOutcome(
    state: RunState,
    plan: ResolvedRunPlan,
    budget: ExecutionBudget,
    emitter: RunEventEmitter,
    result: AgentLoopResult,
    options: {
      readonly validations?: readonly ValidationRecord[];
      readonly contextUsage?: RunState['contextUsage'];
    } = {},
  ): Promise<RunOutcome> {
    const nextState = runStateSchema.parse({
      ...state,
      status: result.status === 'completed' ? 'completed' : 'awaiting-review',
      conversation: result.conversation,
      contextUsage: options.contextUsage ?? [...state.contextUsage, ...result.contextUsage],
      validations: options.validations ?? state.validations,
      ...(result.status === 'completed'
        ? { output: result.output, pendingReview: undefined }
        : { pendingReview: result.review }),
      revision: state.revision + 1,
      updatedAt: nowTimestamp(),
    });
    return this.#finalize(nextState, plan, budget, emitter);
  }

  async #continueToolAgent(
    agent: ToolAgent,
    userRequest: string,
    initialResult: AgentLoopResult,
    state: RunState,
    plan: ResolvedRunPlan,
    context: RuntimeExecutionContext,
  ): Promise<RunOutcome> {
    let result = initialResult;
    const validations = [...state.validations];
    let contextUsage = [...state.contextUsage, ...result.contextUsage];

    while (result.status === 'completed' && plan.validation.enabled) {
      const executionContext = toolExecutionContext(result.conversation);
      if (executionContext.length === 0) break;
      const attempt = validations.length;
      await context.events.emit({ type: 'validation-started', attempt });
      const validator = new ValidatorAgent({
        provider: context.provider,
        profile: requireValidationProfile(plan.validation),
        reserveModelCall: (signal) => context.budget.reserveModelCall(signal),
      });
      const validation = await validator.validate({
        userRequest,
        finalAnswer: result.output,
        executionContext,
        workspacePath: context.workspacePath,
        signal: context.signal,
      });
      const record = validationRecordSchema.parse({
        attempt,
        result: validation,
        createdAt: nowTimestamp(),
      });
      validations.push(record);
      const previousFailures = validations
        .slice(0, -1)
        .filter(({ result: previous }) => !previous.passed).length;
      const willRetry = !validation.passed && previousFailures < plan.validation.maxRetries;
      await context.events.emit({
        type: 'validation-finished',
        attempt,
        result: validation,
        willRetry,
      });
      if (!willRetry) break;

      result = await new ToolAgentRuntime().run(
        agent,
        {
          prompt: formatValidationFeedback(validation),
          promptKind: 'internal-continuation',
          promptScope: 'validator',
          conversation: internalizeRunAssistant(result.conversation, state.runId),
        },
        context,
      );
      contextUsage = [...contextUsage, ...result.contextUsage];
    }

    return this.#agentLoopOutcome(state, plan, context.budget, context.events, result, {
      validations,
      contextUsage,
    });
  }

  async #route(
    agent: AutoAgent,
    input: AgentRunInput,
    context: RuntimeExecutionContext,
  ): Promise<'tool' | 'dag'> {
    context.budget.reserveModelCall(context.signal);
    const schema = z.object({ route: z.enum(['tool', 'dag']), reason: z.string() }).strict();
    const response = await context.provider.chat(
      {
        messages: [
          {
            role: 'system',
            content: `${agent.systemPrompt}\nChoose "tool" for bounded direct work and "dag" for multi-stage dependency-driven work.`,
          },
          { role: 'user', content: input.prompt },
        ],
        responseFormat: {
          name: 'agent_route',
          schema: z.toJSONSchema(schema),
          description: 'Execution route.',
          strict: true,
        },
      },
      { signal: context.signal },
    );
    try {
      return schema.parse(JSON.parse(response.content)).route;
    } catch {
      throw new DagentError('PROVIDER_FAILED', 'AutoAgent router returned invalid JSON.');
    }
  }

  async #finalize(
    state: RunState,
    plan: ResolvedRunPlan,
    budget: ExecutionBudget,
    emitter: RunEventEmitter,
  ): Promise<RunOutcome> {
    if (
      state.conversation !== undefined &&
      (state.status === 'completed' || state.status === 'awaiting-review')
    ) {
      await this.#conversationResources.persist(state.conversation, state.workspacePath);
    }
    const checkpoint = runCheckpointSchema.parse({
      schemaVersion: 5,
      state,
      plan,
      usage: budget.snapshot(),
      createdAt: nowTimestamp(),
    });
    this.#checkpoints.set(state.runId, checkpoint);
    await emitter.emit({ type: 'checkpoint', checkpoint });
    const status =
      state.status === 'completed'
        ? 'completed'
        : state.status === 'awaiting-review'
          ? 'awaiting-review'
          : state.status === 'cancelled'
            ? 'cancelled'
            : state.status === 'interrupted'
              ? 'interrupted'
              : 'failed';
    await emitter.emit({ type: 'run-completed', outcome: status });
    if (status === 'completed') {
      return {
        status,
        state,
        checkpoint,
        ...(state.output === undefined ? {} : { output: state.output }),
      };
    }
    if (status === 'awaiting-review') {
      if (state.pendingReview === undefined) {
        throw new DagentError(
          'CHECKPOINT_MISMATCH',
          'Awaiting-review state has no pending review.',
        );
      }
      return { status, state, checkpoint, review: state.pendingReview };
    }
    return {
      status,
      state,
      checkpoint,
      error: state.error ?? `Run ended with status '${status}'.`,
    };
  }

  async #failedOutcome(
    state: RunState,
    plan: ResolvedRunPlan,
    budget: ExecutionBudget,
    emitter: RunEventEmitter,
    error: unknown,
    signal?: AbortSignal,
  ): Promise<RunOutcome> {
    const status =
      signal?.aborted === true || (error instanceof DagentError && error.code === 'ABORTED')
        ? 'cancelled'
        : 'failed';
    const partialState = partialRunState(error, state.runId) ?? state;
    const failed = runStateSchema.parse({
      ...partialState,
      status,
      error: errorMessage(error),
      pendingReview: undefined,
      revision: partialState.revision + 1,
      updatedAt: nowTimestamp(),
    });
    return this.#finalize(failed, plan, budget, emitter);
  }

  async #prepareAgentInput(
    input: AgentRunInput,
    workspacePath: string,
  ): Promise<PreparedAgentRunInput> {
    const conversation =
      input.conversation === undefined
        ? undefined
        : await this.#conversationResources.materialize(
            conversationStateSchema.parse(input.conversation),
            workspacePath,
          );
    const attachments = await materializeInputUploads(input.uploads ?? [], workspacePath);
    return {
      prompt: input.prompt,
      ...(conversation === undefined ? {} : { conversation }),
      attachments,
    };
  }

  #runtimeContext(
    runId: RunId,
    workspacePath: string,
    signal: AbortSignal,
    events: RunEventEmitter,
    budget: ExecutionBudget,
    plan: ResolvedRunPlan,
  ): RuntimeExecutionContext {
    return {
      runId,
      provider: this.#provider,
      catalog: this.catalog,
      skills: this.skills,
      budget,
      events,
      workspacePath,
      runtimeDirectory: plan.runtimeDirectory,
      signal,
      contextPolicy: plan.contextPolicy,
      resultStoragePolicy: plan.resultStoragePolicy,
      contextWindowTokens: plan.contextWindowTokens,
      outputReserveTokens: plan.outputReserveTokens,
      ...(plan.extraSystemPrompt === undefined
        ? {}
        : { extraSystemPrompt: plan.extraSystemPrompt }),
    };
  }

  #contextForTarget(target: RunTarget): ContextPolicy {
    return target.kind === 'static-dag' ? this.#context : target.context;
  }

  #assertOpen(): void {
    if (this.#closed) throw new DagentError('INVALID_INPUT', 'Runner is closed.');
  }
}

function completedNodeResults(error: unknown): RunState['nodeResults'] {
  if (!(error instanceof DagentError)) return {};
  const value = error.details['results'];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([nodeId, candidate]) => {
      const parsed = dagNodeResultSchema.safeParse(candidate);
      return parsed.success && parsed.data.status === 'completed'
        ? [[nodeId, parsed.data] as const]
        : [];
    }),
  );
}

function allNodeResults(
  error: unknown,
  fallback: RunState['nodeResults'],
): RunState['nodeResults'] {
  if (!(error instanceof DagentError)) return fallback;
  const value = error.details['results'];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fallback;
  const parsed = Object.fromEntries(
    Object.entries(value).flatMap(([nodeId, candidate]) => {
      const result = dagNodeResultSchema.safeParse(candidate);
      return result.success ? [[nodeId, result.data] as const] : [];
    }),
  );
  return { ...fallback, ...parsed };
}

function artifactStatesFromError(error: unknown, fallback: ArtifactStates): ArtifactStates {
  if (!(error instanceof DagentError)) return fallback;
  const parsed = artifactStatesSchema.safeParse(error.details['artifactStates']);
  return parsed.success ? parsed.data : fallback;
}

function partialRunState(error: unknown, runId: RunId): RunState | undefined {
  if (!(error instanceof DagentError)) return undefined;
  const parsed = runStateSchema.safeParse(error.details['partialState']);
  return parsed.success && parsed.data.runId === runId ? parsed.data : undefined;
}

function lastUserRequest(conversation: ConversationState): string {
  const message = conversation.items.findLast(
    (item) => item.type === 'user' && item.visibility === 'user',
  );
  if (message?.type !== 'user') {
    throw new DagentError('CHECKPOINT_MISMATCH', 'Conversation has no public user request.');
  }
  return message.content;
}

function toolExecutionContext(conversation: ConversationState): string {
  return conversation.items
    .flatMap((item) => {
      if (item.type !== 'tool-result') return [];
      const value = item.value === undefined ? '' : `\nValue: ${JSON.stringify(item.value)}`;
      return [
        `Capability ${item.capabilityId ?? item.name} (${item.status}):\n${storedContentText(
          item.content,
        )}${value}`,
      ];
    })
    .join('\n\n');
}

function requireValidationProfile(validation: ValidationPolicy): AgentProfile {
  if (validation.profile === undefined) {
    throw new DagentError(
      'CHECKPOINT_MISMATCH',
      'Enabled result validation has no validator profile.',
    );
  }
  return validation.profile;
}

function internalizeRunAssistant(conversation: ConversationState, runId: RunId): ConversationState {
  const index = conversation.items.findLastIndex(
    (item) => item.type === 'assistant' && item.runId === runId && item.visibility === 'user',
  );
  if (index < 0) return conversation;
  return conversationStateSchema.parse({
    ...conversation,
    revision: conversation.revision + 1,
    items: conversation.items.map((item, itemIndex) =>
      itemIndex === index ? { ...item, visibility: 'internal' as const } : item,
    ),
  });
}

async function createResolvedPlan(
  target: RunTarget,
  catalog: CapabilityCatalog,
  agents: ReadonlyMap<string, ToolAgent | DagAgent | AutoAgent>,
  skills: SkillStore,
  limits: ExecutionLimits,
  contextPolicy: ContextPolicy,
  resultStoragePolicy: ResultStoragePolicy,
  runtimeDirectory: string,
  contextWindowTokens: number,
  outputReserveTokens: number,
  validation: ValidationPolicy,
  extraSystemPrompt: string | undefined,
): Promise<ResolvedRunPlan> {
  const scope = await resolveExecutionScope(target, catalog, agents, skills);
  const payload = resolvedRunPlanPayloadSchema.parse({
    schemaVersion: 5 as const,
    target,
    ...scope,
    limits,
    contextPolicy,
    resultStoragePolicy,
    runtimeDirectory,
    contextWindowTokens,
    outputReserveTokens,
    validation,
    ...(extraSystemPrompt === undefined ? {} : { extraSystemPrompt }),
  });
  return resolvedRunPlanSchema.parse({
    ...payload,
    fingerprint: sha256(JSON.parse(JSON.stringify(payload)) as JsonValue),
  });
}

async function validateCheckpoint(
  checkpointValue: RunCheckpoint,
  catalog: CapabilityCatalog,
  agents: ReadonlyMap<string, ToolAgent | DagAgent | AutoAgent>,
  skills: SkillStore,
): Promise<RunCheckpoint> {
  const checkpoint = runCheckpointSchema.parse(checkpointValue);
  await validateResolvedExecutionScope(checkpoint.plan, catalog, agents, skills);
  return checkpoint;
}

function dynamicAgentForTarget(target: RunTarget): DagAgent | undefined {
  if (target.kind === 'dag-agent') return target;
  if (target.kind === 'auto-agent') return inheritAutoScope(target.dagAgent, target);
  return undefined;
}

function plannerTurnCount(conversation: ConversationState | undefined, runId: RunId): number {
  return (
    conversation?.items.filter(
      (item) => item.type === 'assistant' && item.scope === 'planner' && item.runId === runId,
    ).length ?? 0
  );
}

function isAgentInput(input: RunInput): input is AgentRunInput;
function isAgentInput(input: PreparedRunInput): input is PreparedAgentRunInput;
function isAgentInput(input: RunInput | PreparedRunInput): boolean {
  return 'prompt' in input;
}

function requireAgentInput(input: PreparedRunInput): PreparedAgentRunInput {
  if (!isAgentInput(input)) {
    throw new DagentError('INVALID_INPUT', 'Agent runs require a prompt.');
  }
  if (!isPreparedAgentInput(input)) {
    throw new DagentError('INVALID_INPUT', 'Agent input uploads were not prepared.');
  }
  return input;
}

function assertAgentHistory(input: AgentRunInput): void {
  if (input.conversation !== undefined) conversationStateSchema.parse(input.conversation);
}

function isPreparedAgentInput(input: AgentRunInput): input is PreparedAgentRunInput {
  return 'attachments' in input && Array.isArray(input.attachments);
}

function requiresDagReview(
  level: 'never' | 'risky' | 'always',
  graph: DAGSpec,
  catalog: CapabilityCatalog,
  agents: ReadonlyMap<string, ToolAgent | DagAgent | AutoAgent>,
): boolean {
  if (level === 'never') return false;
  if (level === 'always') return true;
  return graphRequiresRiskReview(graph, catalog, agents);
}

function assertStaticAgentTopology(graph: DAGSpec, nested = false): void {
  for (const node of graph.nodes) {
    if (node.kind === 'agent' && nested) {
      throw new DagentError(
        'INVALID_INPUT',
        `Static DAG agent node '${node.id}' must be a direct top-level node; agent continuation inside Map, Subgraph, or Loop is unsupported.`,
      );
    }
    if (node.kind === 'subgraph' || node.kind === 'map' || node.kind === 'loop') {
      assertStaticAgentTopology(node.graph, true);
    }
  }
}

function capabilityResumeAgent(target: RunTarget): ToolAgent {
  if (target.kind === 'tool-agent') return target;
  if (target.kind === 'auto-agent') return inheritAutoScope(target.toolAgent, target);
  throw new DagentError(
    'CHECKPOINT_MISMATCH',
    `Target '${target.kind}' cannot resume a capability review.`,
  );
}

function inheritAutoScope<TAgent extends ToolAgent | DagAgent>(
  agent: TAgent,
  parent: AutoAgent,
): TAgent {
  return {
    ...agent,
    scope: {
      capabilities: [...new Set([...parent.scope.capabilities, ...agent.scope.capabilities])],
      skills: [...new Set([...parent.scope.skills, ...agent.scope.skills])],
      agents: [...new Set([...parent.scope.agents, ...agent.scope.agents])],
    },
  };
}

function parseAgent(agent: ToolAgent | DagAgent | AutoAgent): ToolAgent | DagAgent | AutoAgent {
  const parsed = runTargetSchema.parse(agent);
  if (parsed.kind === 'static-dag') {
    throw new DagentError('INVALID_INPUT', 'Static DAG targets cannot be registered as agents.');
  }
  return parsed;
}

function readProviderNumber(provider: ChatProvider, key: string, fallback: number): number {
  const value = (provider as unknown as Readonly<Record<string, unknown>>)[key];
  return typeof value === 'number' ? value : fallback;
}
