import type { PendingReview, RunEvent } from 'dagent-ai/contracts';

export function pendingReviewForRun(
  status: string | undefined,
  checkpointReview: PendingReview | undefined,
  events: readonly RunEvent[],
): PendingReview | undefined {
  if (status !== 'awaiting-review') return undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'checkpoint') return event.checkpoint.state.pendingReview;
    if (event?.type === 'run-completed' && event.outcome !== 'awaiting-review') return undefined;
    if (event?.type === 'review-required') return event.review;
  }
  return checkpointReview;
}
