import type {
  ReviewDecision,
  RunCheckpoint,
  RunEvent,
  RunId,
  RunInput,
  RunTarget,
} from 'dagent-ai';
import { DagentError, type Runner } from 'dagent-ai';
import { reviewDecisionSchema, runIdSchema, runTargetSchema } from 'dagent-ai/contracts';
import { join } from 'node:path';

import { requireConversationState, type AppRepository } from '../database/repositories.js';

export type RunEventListener = (event: RunEvent) => void;

export class RunService {
  readonly #listeners = new Map<RunId, Set<RunEventListener>>();
  readonly #tasks = new Set<Promise<void>>();
  readonly #busyConversations = new Set<string>();
  #closed = false;

  public constructor(
    private readonly runner: Runner,
    private readonly repository: AppRepository,
    private readonly workspaceRoots: {
      readonly savedDagRuns: string;
      readonly standaloneConversations: string;
    } = {
      savedDagRuns: join(runner.workspacePath, 'projects', '_runs'),
      standaloneConversations: join(runner.workspacePath, 'standalone'),
    },
  ) {}

  public async start(input: {
    readonly conversationId?: string;
    readonly savedDagId?: string;
    readonly orchestrationSessionId?: string;
    readonly target: RunTarget;
    readonly runInput: RunInput;
  }): Promise<RunId> {
    if (this.#closed) throw new Error('Run service is closed.');
    const target = runTargetSchema.parse(input.target);
    if (input.conversationId !== undefined) {
      await this.#claimConversation(input.conversationId);
    }
    let prepared: {
      readonly input: RunInput;
      readonly conversationRevision?: number;
      readonly workspacePath?: string;
    };
    try {
      prepared = await this.#withConversation(input.conversationId, input.runInput);
    } catch (error) {
      this.#releaseConversation(input.conversationId);
      throw error;
    }
    let resolveStarted!: (runId: RunId) => void;
    let rejectStarted!: (error: unknown) => void;
    const started = new Promise<RunId>((resolvePromise, reject) => {
      resolveStarted = resolvePromise;
      rejectStarted = reject;
    });
    this.#track(
      this.#consumeNewRun(
        target,
        prepared.input,
        {
          ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
          ...(input.savedDagId === undefined ? {} : { savedDagId: input.savedDagId }),
          ...(input.orchestrationSessionId === undefined
            ? {}
            : { orchestrationSessionId: input.orchestrationSessionId }),
        },
        resolveStarted,
        rejectStarted,
        prepared.conversationRevision,
        input.savedDagId === undefined ? prepared.workspacePath : undefined,
        input.savedDagId === undefined ? undefined : this.workspaceRoots.savedDagRuns,
      ),
    );
    return started;
  }

  public async resume(runIdValue: RunId, decisionValue: ReviewDecision): Promise<void> {
    if (this.#closed) throw new Error('Run service is closed.');
    const runId = runIdSchema.parse(runIdValue);
    const decision = reviewDecisionSchema.parse(decisionValue);
    const run = await this.repository.claimRunReview(runId, decision);
    if (run?.checkpoint === undefined) {
      throw new DagentError(
        'STALE_REVIEW',
        `Run '${runId}' does not have a matching unclaimed review checkpoint.`,
      );
    }
    if (run.conversationId !== undefined) this.#busyConversations.add(run.conversationId);
    this.#track(
      this.#consumeResume(runId, run, decision).catch(() =>
        this.repository.updateRun(runId, 'failed').catch(() => undefined),
      ),
    );
  }

  async #consumeResume(
    runId: RunId,
    run: NonNullable<Awaited<ReturnType<AppRepository['getRun']>>>,
    decision: ReviewDecision,
  ): Promise<void> {
    if (run.checkpoint === undefined) return;
    const priorEvents = await this.repository.eventsAfter(runId, 0);
    let nextSequence = priorEvents.at(-1)?.sequence ?? 0;
    let conversationRevision = run.checkpoint.state.conversation?.revision;
    let retainConversationClaim = false;
    try {
      for await (const rawEvent of this.runner.resumeStream(run.checkpoint, decision)) {
        const event = { ...rawEvent, sequence: ++nextSequence };
        await this.repository.appendEvent(event);
        if (event.type === 'checkpoint') {
          retainConversationClaim = event.checkpoint.state.status === 'awaiting-review';
          const persisted = await this.repository.persistRunCheckpoint(
            runId,
            event.checkpoint.state.status,
            event.checkpoint,
            run.conversationId === undefined || conversationRevision === undefined
              ? undefined
              : {
                  id: run.conversationId,
                  expectedRevision: conversationRevision,
                },
          );
          if (!persisted) {
            throw conversationChanged(run.conversationId);
          }
          conversationRevision = event.checkpoint.state.conversation?.revision;
        }
        this.#publish(event);
      }
    } finally {
      if (!retainConversationClaim) this.#releaseConversation(run.conversationId);
    }
  }

  public cancel(runId: RunId): boolean {
    return this.runner.cancel(runId);
  }

  public on(runId: RunId, listener: RunEventListener): () => void {
    const listeners = this.#listeners.get(runId) ?? new Set<RunEventListener>();
    listeners.add(listener);
    this.#listeners.set(runId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(runId);
    };
  }

  public eventsAfter(runId: RunId, sequence: number): Promise<readonly RunEvent[]> {
    return this.repository.eventsAfter(runId, sequence);
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.runner.close();
    await Promise.allSettled([...this.#tasks]);
    this.#listeners.clear();
    this.#busyConversations.clear();
  }

  async #consumeNewRun(
    target: RunTarget,
    input: RunInput,
    associations: {
      readonly conversationId?: string;
      readonly savedDagId?: string;
      readonly orchestrationSessionId?: string;
    },
    resolveStarted: (runId: RunId) => void,
    rejectStarted: (error: unknown) => void,
    conversationRevision?: number,
    workspacePath?: string,
    workspaceRoot?: string,
  ): Promise<void> {
    let runId: RunId | undefined;
    let checkpoint: RunCheckpoint | undefined;
    let retainConversationClaim = false;
    try {
      for await (const event of this.runner.stream(
        target,
        input,
        workspacePath !== undefined
          ? { workspacePath }
          : workspaceRoot === undefined
            ? {}
            : { workspaceRoot },
      )) {
        if (runId === undefined) {
          const startedRunId = event.runId;
          await this.repository.insertRun({
            id: startedRunId,
            ...associations,
            target,
            runInput: persistedRunInput(input),
          });
          runId = startedRunId;
          resolveStarted(startedRunId);
        }
        await this.repository.appendEvent(event);
        if (event.type === 'checkpoint') {
          checkpoint = event.checkpoint;
          const persisted = await this.repository.persistRunCheckpoint(
            runId,
            event.checkpoint.state.status,
            event.checkpoint,
            associations.conversationId === undefined || conversationRevision === undefined
              ? undefined
              : {
                  id: associations.conversationId,
                  expectedRevision: conversationRevision,
                },
          );
          if (!persisted) {
            throw conversationChanged(associations.conversationId);
          }
          conversationRevision = event.checkpoint.state.conversation?.revision;
        }
        this.#publish(event);
      }
      retainConversationClaim = checkpoint?.state.status === 'awaiting-review';
    } catch (error) {
      if (runId === undefined) {
        rejectStarted(error);
      } else {
        await this.repository.updateRun(runId, 'failed', checkpoint).catch(() => undefined);
      }
    } finally {
      if (!retainConversationClaim) this.#releaseConversation(associations.conversationId);
    }
  }

  async #withConversation(
    conversationId: string | undefined,
    input: RunInput,
  ): Promise<{
    readonly input: RunInput;
    readonly conversationRevision?: number;
    readonly workspacePath?: string;
  }> {
    if (conversationId === undefined) return { input };
    const stored = await this.repository.getConversation(conversationId);
    if (stored === undefined) {
      throw new Error(`Conversation '${conversationId}' was not found.`);
    }
    const workspacePath =
      stored.workspaceScope === 'standalone'
        ? join(this.workspaceRoots.standaloneConversations, stored.id, 'workspace')
        : await this.#projectWorkspace(stored.projectId);
    return {
      input:
        'prompt' in input
          ? {
              ...input,
              conversation: requireConversationState(stored),
            }
          : input,
      ...('prompt' in input ? { conversationRevision: stored.revision } : {}),
      workspacePath,
    };
  }

  async #projectWorkspace(projectId: string | undefined): Promise<string> {
    if (projectId === undefined) {
      throw new Error('Project-scoped conversation has no project id.');
    }
    const project = await this.repository.getProject(projectId);
    if (project === undefined) throw new Error(`Project '${projectId}' was not found.`);
    return project.rootPath;
  }

  #publish(event: RunEvent): void {
    for (const listener of this.#listeners.get(event.runId) ?? []) listener(event);
  }

  async #claimConversation(conversationId: string): Promise<void> {
    if (this.#busyConversations.has(conversationId)) {
      throw conversationBusy(conversationId);
    }
    this.#busyConversations.add(conversationId);
    try {
      const persistedRuns = await this.repository.listRuns({ conversationId });
      if (
        persistedRuns.some(({ status }) =>
          ['pending', 'planning', 'running', 'resuming', 'awaiting-review'].includes(status),
        )
      ) {
        throw conversationBusy(conversationId);
      }
    } catch (error) {
      this.#busyConversations.delete(conversationId);
      throw error;
    }
  }

  #releaseConversation(conversationId: string | undefined): void {
    if (conversationId !== undefined) this.#busyConversations.delete(conversationId);
  }

  #track(task: Promise<void>): void {
    this.#tasks.add(task);
    void task.then(
      () => {
        this.#tasks.delete(task);
      },
      () => {
        this.#tasks.delete(task);
      },
    );
  }
}

function conversationBusy(conversationId: string): DagentError {
  return new DagentError(
    'CONCURRENCY_CONFLICT',
    `Conversation '${conversationId}' already has an active or review-pending run.`,
  );
}

function conversationChanged(conversationId: string | undefined): DagentError {
  return new DagentError(
    'CONCURRENCY_CONFLICT',
    conversationId === undefined
      ? 'The run checkpoint was concurrently changed.'
      : `Conversation '${conversationId}' changed while its run was active.`,
  );
}

function persistedRunInput(input: RunInput): unknown {
  if ('prompt' in input) {
    return {
      prompt: input.prompt,
      ...(input.uploads === undefined
        ? {}
        : {
            uploads: input.uploads.map(({ filename, content }) => ({
              filename,
              byteLength: content.byteLength,
            })),
          }),
    };
  }
  return {
    ...(input.graphInput === undefined ? {} : { graphInput: input.graphInput }),
    ...(input.artifactUploads === undefined
      ? {}
      : {
          artifactUploads: Object.fromEntries(
            Object.entries(input.artifactUploads).map(([artifactId, uploads]) => [
              artifactId,
              uploads.map(({ filename, content }) => ({
                filename,
                byteLength: content.byteLength,
              })),
            ]),
          ),
        }),
  };
}
