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

import { type AppRepository } from '../database/repositories.js';

export type RunEventListener = (event: RunEvent) => void;

export class RunService {
  readonly #listeners = new Map<RunId, Set<RunEventListener>>();
  readonly #tasks = new Set<Promise<void>>();
  readonly #busyConversations = new Set<string>();
  #closed = false;

  public constructor(
    private readonly runner: Runner,
    private readonly repository: AppRepository,
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
    let runInput: RunInput;
    try {
      runInput = await this.#withConversation(input.conversationId, input.runInput);
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
        runInput,
        {
          ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
          ...(input.savedDagId === undefined ? {} : { savedDagId: input.savedDagId }),
          ...(input.orchestrationSessionId === undefined
            ? {}
            : { orchestrationSessionId: input.orchestrationSessionId }),
        },
        resolveStarted,
        rejectStarted,
      ),
    );
    return started;
  }

  public async resume(runIdValue: RunId, decisionValue: ReviewDecision): Promise<void> {
    if (this.#closed) throw new Error('Run service is closed.');
    const runId = runIdSchema.parse(runIdValue);
    const decision = reviewDecisionSchema.parse(decisionValue);
    const run = await this.repository.getRun(runId);
    if (run?.checkpoint === undefined) {
      throw new Error(`Run '${runId}' has no resumable checkpoint.`);
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
    let retainConversationClaim = false;
    try {
      for await (const rawEvent of this.runner.resumeStream(run.checkpoint, decision)) {
        const event = { ...rawEvent, sequence: ++nextSequence };
        await this.repository.appendEvent(event);
        if (event.type === 'checkpoint') {
          retainConversationClaim = event.checkpoint.state.status === 'awaiting-review';
          await this.repository.updateRun(runId, event.checkpoint.state.status, event.checkpoint);
          if (run.conversationId !== undefined) {
            await this.repository.updateConversationFromCheckpoint(
              run.conversationId,
              event.checkpoint,
            );
          }
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
  ): Promise<void> {
    let runId: RunId | undefined;
    let checkpoint: RunCheckpoint | undefined;
    let retainConversationClaim = false;
    try {
      for await (const event of this.runner.stream(target, input)) {
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
          await this.repository.updateRun(runId, event.checkpoint.state.status, event.checkpoint);
          if (associations.conversationId !== undefined) {
            await this.repository.updateConversationFromCheckpoint(
              associations.conversationId,
              event.checkpoint,
            );
          }
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

  async #withConversation(conversationId: string | undefined, input: RunInput): Promise<RunInput> {
    if (conversationId === undefined || !('prompt' in input)) return input;
    const stored = await this.repository.getConversation(conversationId);
    if (stored === undefined) {
      throw new Error(`Conversation '${conversationId}' was not found.`);
    }
    return {
      ...input,
      conversation: stored.conversation,
    };
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
          ['pending', 'planning', 'running', 'awaiting-review'].includes(status),
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

function persistedRunInput(input: RunInput): unknown {
  if ('prompt' in input) return { prompt: input.prompt };
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
