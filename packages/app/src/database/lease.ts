import type { AppDatabase } from './database.js';

export class WriterLease implements AsyncDisposable {
  readonly #database: AppDatabase;
  readonly #resource: string;
  readonly #holder: string;
  readonly #ttlMs: number;
  readonly #timer: NodeJS.Timeout;

  private constructor(database: AppDatabase, resource: string, holder: string, ttlMs: number) {
    this.#database = database;
    this.#resource = resource;
    this.#holder = holder;
    this.#ttlMs = ttlMs;
    this.#timer = setInterval(() => void this.#renew(), Math.floor(ttlMs / 3));
    this.#timer.unref();
  }

  public static async acquire(
    database: AppDatabase,
    resource = 'app-writer',
    ttlMs = 15_000,
  ): Promise<WriterLease> {
    const holder = `${process.pid}:${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    await database.transaction().execute(async (transaction) => {
      await transaction
        .deleteFrom('leases')
        .where('resource', '=', resource)
        .where('expires_at', '<=', now)
        .execute();
      await transaction
        .insertInto('leases')
        .values({ resource, holder, expires_at: expiresAt })
        .onConflict((conflict) => conflict.column('resource').doNothing())
        .execute();
      const current = await transaction
        .selectFrom('leases')
        .select('holder')
        .where('resource', '=', resource)
        .executeTakeFirstOrThrow();
      if (current.holder !== holder) {
        throw new Error(
          'Another dagent-ai-app process owns this database. Stop it or use a different data directory.',
        );
      }
    });
    return new WriterLease(database, resource, holder, ttlMs);
  }

  async #renew(): Promise<void> {
    const result = await this.#database
      .updateTable('leases')
      .set({ expires_at: new Date(Date.now() + this.#ttlMs).toISOString() })
      .where('resource', '=', this.#resource)
      .where('holder', '=', this.#holder)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) !== 1) {
      clearInterval(this.#timer);
    }
  }

  public async close(): Promise<void> {
    clearInterval(this.#timer);
    await this.#database
      .deleteFrom('leases')
      .where('resource', '=', this.#resource)
      .where('holder', '=', this.#holder)
      .execute();
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
