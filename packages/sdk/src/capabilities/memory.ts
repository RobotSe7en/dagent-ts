import { z } from 'zod';

import type { JsonValue } from '../contracts/index.js';
import { jsonValueSchema } from '../contracts/index.js';
import { tool, type CapabilityBinding } from './tool.js';

export class MemoryStore {
  readonly #values = new Map<string, JsonValue>();

  public get(key: string): JsonValue | undefined {
    return this.#values.get(key);
  }

  public set(key: string, value: JsonValue): void {
    this.#values.set(key, value);
  }

  public delete(key: string): boolean {
    return this.#values.delete(key);
  }

  public entries(): readonly (readonly [string, JsonValue])[] {
    return [...this.#values.entries()];
  }
}

export function createMemoryTools(store = new MemoryStore()): readonly CapabilityBinding[] {
  return [
    tool({
      id: 'tool.memory_get',
      description: 'Read a value from run memory.',
      input: z.object({ key: z.string().min(1) }).strict(),
      output: z.object({ found: z.boolean(), value: jsonValueSchema.optional() }).strict(),
      execute: ({ key }) => {
        const value = store.get(key);
        return value === undefined ? { found: false } : { found: true, value };
      },
    }),
    tool({
      id: 'tool.memory_set',
      description: 'Store a JSON value in run memory.',
      input: z.object({ key: z.string().min(1), value: jsonValueSchema }).strict(),
      output: z.object({ stored: z.literal(true) }).strict(),
      execute: ({ key, value }) => {
        store.set(key, value);
        return { stored: true as const };
      },
    }),
  ];
}
