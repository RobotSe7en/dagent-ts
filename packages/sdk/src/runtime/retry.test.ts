import { afterEach, describe, expect, it, vi } from 'vitest';

import { withRetry } from './retry.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('withRetry', () => {
  it('retries according to the exact delay policy and returns the first success', async () => {
    vi.useFakeTimers();
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('second'))
      .mockResolvedValue('ok');
    const result = withRetry(operation, { policy: { delaysMs: [10, 20] } });

    await vi.advanceTimersByTimeAsync(10);
    expect(operation).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20);

    await expect(result).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('does not retry errors rejected by the retryability predicate', async () => {
    const operation = vi.fn().mockRejectedValue(new TypeError('invalid'));

    await expect(
      withRetry(operation, {
        policy: { delaysMs: [0, 0] },
        retryable: (error) => !(error instanceof TypeError),
      }),
    ).rejects.toThrow('invalid');
    expect(operation).toHaveBeenCalledOnce();
  });

  it('throws the last error after the retry budget is exhausted', async () => {
    const first = new Error('first');
    const last = new Error('last');
    const operation = vi.fn().mockRejectedValueOnce(first).mockRejectedValueOnce(last);

    await expect(withRetry(operation, { policy: { delaysMs: [0] } })).rejects.toBe(last);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('aborts while waiting without starting another attempt', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const operation = vi.fn().mockRejectedValue(new Error('retry'));
    const result = withRetry(operation, {
      policy: { delaysMs: [1000] },
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(1);

    controller.abort(new Error('stop now'));

    await expect(result).rejects.toThrow('stop now');
    expect(operation).toHaveBeenCalledOnce();
  });

  it('rejects an already aborted operation with a stable error code', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      withRetry(async () => 'never', { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'ABORTED' });
  });
});
