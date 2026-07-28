import { errorMessage } from '../errors.js';

export class AsyncEventQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<(result: IteratorResult<T>) => void> = [];
  #closed = false;
  #error: unknown;

  public push(value: T): void {
    if (this.#closed) throw new Error('Cannot push to a closed event queue.');
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#values.push(value);
    else waiter({ done: false, value });
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  public fail(error: unknown): void {
    this.#error = error;
    this.close();
  }

  public [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const value = this.#values.shift();
        if (value !== undefined) return { done: false, value };
        if (this.#closed) {
          if (this.#error !== undefined) {
            throw this.#error instanceof Error ? this.#error : new Error(errorMessage(this.#error));
          }
          return { done: true, value: undefined };
        }
        return new Promise<IteratorResult<T>>((resolvePromise) => {
          this.#waiters.push(resolvePromise);
        });
      },
    };
  }
}
