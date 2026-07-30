import type { RunEvent } from 'dagent-ai';
import { describe, expect, it } from 'vitest';

import { projectStreamedContent } from './stream-projection.js';

describe('chat stream projection', () => {
  it('drops a rejected draft before projecting retry tokens', () => {
    let content = projectStreamedContent(
      '',
      event({ type: 'token', channel: 'content', content: 'draft' }),
    );
    content = projectStreamedContent(
      content,
      event({
        type: 'validation-finished',
        attempt: 0,
        result: { passed: false, summary: 'retry', issues: [{ message: 'incorrect' }] },
        willRetry: true,
      }),
    );
    content = projectStreamedContent(
      content,
      event({ type: 'token', channel: 'content', content: 'accepted' }),
    );

    expect(content).toBe('accepted');
  });

  it('keeps review-pending content but clears a terminal projection', () => {
    const pending = projectStreamedContent(
      'draft',
      event({ type: 'run-completed', outcome: 'awaiting-review' }),
    );
    const completed = projectStreamedContent(
      pending,
      event({ type: 'run-completed', outcome: 'completed' }),
    );

    expect(pending).toBe('draft');
    expect(completed).toBe('');
  });
});

type RunEventInput = RunEvent extends infer TEvent
  ? TEvent extends RunEvent
    ? Omit<TEvent, 'runId' | 'sequence' | 'timestamp'>
    : never
  : never;

function event(value: RunEventInput): RunEvent {
  return {
    ...value,
    runId: 'run_projection' as never,
    sequence: 1,
    timestamp: new Date().toISOString(),
  };
}
