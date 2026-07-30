import { useMutation } from '@tanstack/react-query';
import type { RunEvent } from 'dagent-ai';

import { api } from '../../api/client.js';

export function ReviewBanner(props: {
  readonly runId: Parameters<typeof api.review>[0];
  readonly event: Extract<RunEvent, { type: 'review-required' }>;
}) {
  const review = useMutation({
    mutationFn: (action: 'approve' | 'reject') =>
      api.review(props.runId, {
        reviewId: props.event.review.id,
        revision: props.event.review.revision,
        action,
        reason: '',
      }),
  });
  if (review.isSuccess) return null;
  return (
    <div className="review-banner">
      <div>
        <strong>需要确认</strong>
        <span>{props.event.review.summary}</span>
        {review.error instanceof Error ? (
          <span className="review-error">{review.error.message}</span>
        ) : null}
      </div>
      <button
        onClick={() => {
          review.mutate('reject');
        }}
        disabled={review.isPending}
      >
        拒绝
      </button>
      <button
        className="primary"
        onClick={() => {
          review.mutate('approve');
        }}
        disabled={review.isPending}
      >
        批准
      </button>
    </div>
  );
}
