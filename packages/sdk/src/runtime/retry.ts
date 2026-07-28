import { DagentError, errorMessage, throwIfAborted } from '../errors.js';

export type RetryPolicy = {
  readonly delaysMs: readonly number[];
};

export const defaultRetryPolicy: RetryPolicy = {
  delaysMs: [1000, 2000, 5000, 10_000, 30_000],
};

export async function withRetry<T>(
  operation: () => Promise<T>,
  options: {
    readonly policy?: RetryPolicy;
    readonly signal?: AbortSignal;
    readonly retryable?: (error: unknown) => boolean;
  } = {},
): Promise<T> {
  const policy = options.policy ?? defaultRetryPolicy;
  let lastError: unknown;
  for (let attempt = 0; attempt <= policy.delaysMs.length; attempt += 1) {
    throwIfAborted(options.signal);
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === policy.delaysMs.length || options.retryable?.(error) === false) {
        throw error;
      }
      const delay = policy.delaysMs[attempt];
      if (delay !== undefined) await abortableDelay(delay, options.signal);
    }
  }
  throw new Error(errorMessage(lastError));
}

async function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const abort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new DagentError('ABORTED', 'The operation was cancelled.', {
              cause: signal?.reason,
            }),
      );
    };
    const finish = (): void => {
      signal?.removeEventListener('abort', abort);
      resolvePromise();
    };
    const timer = setTimeout(finish, delayMs);
    if (signal === undefined) return;
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}
