import type { RunEvent, RunId } from '../contracts/index.js';
import { nowTimestamp, runEventSchema } from '../contracts/index.js';

type RunEventInput = RunEvent extends infer TEvent
  ? TEvent extends RunEvent
    ? Omit<TEvent, 'runId' | 'sequence' | 'timestamp'>
    : never
  : never;

export class RunEventEmitter {
  readonly #runId: RunId;
  readonly #listener: ((event: RunEvent) => void | Promise<void>) | undefined;
  #sequence = 0;

  public constructor(runId: RunId, listener?: (event: RunEvent) => void | Promise<void>) {
    this.#runId = runId;
    this.#listener = listener;
  }

  public get runId(): RunId {
    return this.#runId;
  }

  public async emit(event: RunEventInput): Promise<RunEvent> {
    const normalized = runEventSchema.parse({
      ...event,
      runId: this.#runId,
      sequence: ++this.#sequence,
      timestamp: nowTimestamp(),
    });
    await this.#listener?.(normalized);
    return normalized;
  }
}
