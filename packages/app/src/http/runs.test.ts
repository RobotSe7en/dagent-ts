import type { RunEvent } from 'dagent-ai';
import { describe, expect, it } from 'vitest';

import { canDeleteRun, subscribeRunEvents } from './routes/runs.js';

describe('run event replay', () => {
  it('keeps review-pending runs until the review is resolved', () => {
    expect(canDeleteRun('awaiting-review')).toBe(false);
    expect(canDeleteRun('completed')).toBe(true);
  });

  it('buffers live events until the backlog has been sent in sequence order', async () => {
    const sent: number[] = [];
    let publish!: (event: RunEvent) => void;
    let resolveBacklog!: (events: readonly RunEvent[]) => void;
    const backlog = new Promise<readonly RunEvent[]>((resolvePromise) => {
      resolveBacklog = resolvePromise;
    });
    const subscription = subscribeRunEvents(
      () => backlog,
      (listener) => {
        publish = listener;
        return () => undefined;
      },
      (event) => {
        if (!sent.includes(event.sequence)) sent.push(event.sequence);
      },
    );

    publish(runStarted(3));
    resolveBacklog([runStarted(1), runStarted(2)]);
    await subscription;

    expect(sent).toEqual([1, 2, 3]);
  });
});

function runStarted(sequence: number): RunEvent {
  return {
    type: 'run-started',
    runId: 'run_replay' as never,
    sequence,
    timestamp: new Date().toISOString(),
  };
}
