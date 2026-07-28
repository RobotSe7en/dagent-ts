import type { JsonObject } from 'dagent-ai';
import { jsonObjectSchema } from 'dagent-ai/contracts';
import { z } from 'zod';

import type { AppDatabase } from './database.js';
import type { ModelProviderTable } from './schema.js';

export const reasoningConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    effort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
    budgetTokens: z.number().int().positive().optional(),
    capture: z.enum(['field', 'field-and-tags']).optional(),
  })
  .strict();

export type ModelProviderConfig = {
  readonly id: string;
  readonly name: string;
  readonly source: 'config' | 'managed';
  readonly baseURL: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly apiKeyEnv?: string;
  readonly timeoutMs: number;
  readonly contextWindowTokens: number;
  readonly outputReserveTokens: number;
  readonly reasoning?: z.infer<typeof reasoningConfigSchema>;
  readonly streamIncludeUsage: boolean;
  readonly extraRequestArgs: JsonObject;
  readonly extraBody: JsonObject;
  readonly active: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type ModelProviderWrite = Omit<ModelProviderConfig, 'active' | 'createdAt' | 'updatedAt'>;

export class ModelProviderRepository {
  public constructor(private readonly database: AppDatabase) {}

  public async upsertConfigured(input: ModelProviderWrite): Promise<ModelProviderConfig> {
    const timestamp = new Date().toISOString();
    await this.database.transaction().execute(async (transaction) => {
      const active = await transaction
        .selectFrom('model_providers')
        .select('id')
        .where('active', '=', 1)
        .executeTakeFirst();
      const existing = await transaction
        .selectFrom('model_providers')
        .select(['api_key', 'created_at'])
        .where('id', '=', input.id)
        .executeTakeFirst();
      const row = writeRow(input, {
        active: active === undefined || active.id === input.id,
        apiKey: input.apiKey ?? existing?.api_key ?? undefined,
        createdAt: existing?.created_at ?? timestamp,
        updatedAt: timestamp,
      });
      await transaction
        .insertInto('model_providers')
        .values(row)
        .onConflict((conflict) =>
          conflict.column('id').doUpdateSet({
            name: row.name,
            source: row.source,
            base_url: row.base_url,
            model: row.model,
            api_key: row.api_key,
            api_key_env: row.api_key_env,
            timeout_ms: row.timeout_ms,
            context_window_tokens: row.context_window_tokens,
            output_reserve_tokens: row.output_reserve_tokens,
            reasoning_json: row.reasoning_json,
            stream_include_usage: row.stream_include_usage,
            extra_request_args_json: row.extra_request_args_json,
            extra_body_json: row.extra_body_json,
            active: row.active,
            updated_at: row.updated_at,
          }),
        )
        .execute();
    });
    return requireModel(await this.get(input.id), input.id);
  }

  public async list(): Promise<readonly ModelProviderConfig[]> {
    const rows = await this.database
      .selectFrom('model_providers')
      .selectAll()
      .orderBy('created_at')
      .execute();
    return rows.map(readModel);
  }

  public async get(id: string): Promise<ModelProviderConfig | undefined> {
    const row = await this.database
      .selectFrom('model_providers')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : readModel(row);
  }

  public async create(input: ModelProviderWrite): Promise<ModelProviderConfig> {
    const timestamp = new Date().toISOString();
    const active =
      (await this.database
        .selectFrom('model_providers')
        .select('id')
        .where('active', '=', 1)
        .executeTakeFirst()) === undefined;
    await this.database
      .insertInto('model_providers')
      .values(
        writeRow(input, {
          active,
          apiKey: input.apiKey,
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      )
      .executeTakeFirstOrThrow();
    return requireModel(await this.get(input.id), input.id);
  }

  public async update(
    id: string,
    input: ModelProviderWrite,
  ): Promise<ModelProviderConfig | undefined> {
    const existing = await this.get(id);
    if (existing === undefined) return undefined;
    const row = writeRow(input, {
      active: existing.active,
      apiKey: input.apiKey,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    });
    await this.database
      .updateTable('model_providers')
      .set({
        name: row.name,
        base_url: row.base_url,
        model: row.model,
        api_key: row.api_key,
        api_key_env: row.api_key_env,
        timeout_ms: row.timeout_ms,
        context_window_tokens: row.context_window_tokens,
        output_reserve_tokens: row.output_reserve_tokens,
        reasoning_json: row.reasoning_json,
        stream_include_usage: row.stream_include_usage,
        extra_request_args_json: row.extra_request_args_json,
        extra_body_json: row.extra_body_json,
        updated_at: row.updated_at,
      })
      .where('id', '=', id)
      .execute();
    return this.get(id);
  }

  public async activate(id: string): Promise<ModelProviderConfig | undefined> {
    return this.database.transaction().execute(async (transaction) => {
      const existing = await transaction
        .selectFrom('model_providers')
        .select('id')
        .where('id', '=', id)
        .executeTakeFirst();
      if (existing === undefined) return undefined;
      await transaction.updateTable('model_providers').set({ active: 0 }).execute();
      await transaction
        .updateTable('model_providers')
        .set({ active: 1, updated_at: new Date().toISOString() })
        .where('id', '=', id)
        .execute();
      const row = await transaction
        .selectFrom('model_providers')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      return readModel(row);
    });
  }

  public async delete(id: string): Promise<boolean> {
    const result = await this.database
      .deleteFrom('model_providers')
      .where('id', '=', id)
      .where('source', '=', 'managed')
      .where('active', '=', 0)
      .executeTakeFirst();
    return Number(result.numDeletedRows) === 1;
  }
}

function writeRow(
  input: ModelProviderWrite,
  metadata: {
    readonly active: boolean;
    readonly apiKey: string | null | undefined;
    readonly createdAt: string;
    readonly updatedAt: string;
  },
): ModelProviderTable {
  return {
    id: input.id,
    name: input.name,
    source: input.source,
    base_url: input.baseURL,
    model: input.model,
    api_key: metadata.apiKey ?? null,
    api_key_env: input.apiKeyEnv ?? null,
    timeout_ms: input.timeoutMs,
    context_window_tokens: input.contextWindowTokens,
    output_reserve_tokens: input.outputReserveTokens,
    reasoning_json: JSON.stringify(input.reasoning ?? null),
    stream_include_usage: input.streamIncludeUsage ? 1 : 0,
    extra_request_args_json: JSON.stringify(jsonObjectSchema.parse(input.extraRequestArgs)),
    extra_body_json: JSON.stringify(jsonObjectSchema.parse(input.extraBody)),
    active: metadata.active ? 1 : 0,
    created_at: metadata.createdAt,
    updated_at: metadata.updatedAt,
  };
}

function readModel(row: ModelProviderTable): ModelProviderConfig {
  const reasoningValue: unknown = JSON.parse(row.reasoning_json);
  const reasoning =
    reasoningValue === null ? undefined : reasoningConfigSchema.parse(reasoningValue);
  return {
    id: row.id,
    name: row.name,
    source: z.enum(['config', 'managed']).parse(row.source),
    baseURL: row.base_url,
    model: row.model,
    ...(row.api_key === null ? {} : { apiKey: row.api_key }),
    ...(row.api_key_env === null ? {} : { apiKeyEnv: row.api_key_env }),
    timeoutMs: row.timeout_ms,
    contextWindowTokens: row.context_window_tokens,
    outputReserveTokens: row.output_reserve_tokens,
    ...(reasoning === undefined ? {} : { reasoning }),
    streamIncludeUsage: row.stream_include_usage === 1,
    extraRequestArgs: jsonObjectSchema.parse(JSON.parse(row.extra_request_args_json)),
    extraBody: jsonObjectSchema.parse(JSON.parse(row.extra_body_json)),
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function requireModel(model: ModelProviderConfig | undefined, id: string): ModelProviderConfig {
  if (model === undefined) throw new Error(`Model provider '${id}' was not persisted.`);
  return model;
}
