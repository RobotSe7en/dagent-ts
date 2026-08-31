import { describe, expect, it } from 'vitest';

import type { PendingReview, RunEvent } from 'dagent-ai/contracts';

import { pendingReviewForRun } from '../src/renderer/run-events.js';

const review = {
  id: 'review_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  revision: 1,
  kind: 'capability-review',
  summary: 'Approve the capability.',
  rerunNodeIds: [],
  metadata: {},
  createdAt: '2026-08-31T00:00:00.000Z',
} as unknown as PendingReview;

describe('desktop run event projection', () => {
  it('hides a consumed review while the persisted run is resuming', () => {
    expect(
      pendingReviewForRun('resuming', review, [event({ type: 'review-required', review })]),
    ).toBeUndefined();
  });

  it('does not revive a review superseded by a terminal event', () => {
    expect(
      pendingReviewForRun('awaiting-review', review, [
        event({ type: 'review-required', review }),
        event({ type: 'run-completed', outcome: 'completed' }),
      ]),
    ).toBeUndefined();
  });

  it('uses the latest checkpoint as the authoritative pending-review state', () => {
    expect(
      pendingReviewForRun('awaiting-review', review, [
        event({ type: 'review-required', review }),
        event({ type: 'checkpoint', checkpoint: { state: {} } }),
      ]),
    ).toBeUndefined();
  });
});

function event(value: object): RunEvent {
  return value as RunEvent;
}
