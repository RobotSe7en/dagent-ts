import {
  boundarySchema,
  capabilityIdSchema,
  jsonSchemaSchema,
  riskLevelSchema,
} from 'dagent-ai/contracts';
import { z } from 'zod';

import type { AppDatabase } from './database.js';
import type { TemplateCapabilityTable } from './schema.js';

export const templateCapabilityConfigSchema = z
  .object({
    id: capabilityIdSchema.refine((id) => id.startsWith('tool.'), {
      message: 'Template capability ids must use the tool namespace.',
    }),
    name: z.string().trim().min(1).max(200),
    description: z.string().max(10_000).default(''),
    template: z.string().max(100_000),
    inputSchema: jsonSchemaSchema.default({
      type: 'object',
      additionalProperties: true,
    }),
    risk: riskLevelSchema.default('low'),
    boundary: boundarySchema.prefault({}),
  })
  .strict();

export type TemplateCapabilityConfig = z.infer<typeof templateCapabilityConfigSchema>;

export type StoredTemplateCapability = {
  readonly config: TemplateCapabilityConfig;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export class TemplateCapabilityRepository {
  public constructor(private readonly database: AppDatabase) {}

  public async list(): Promise<readonly StoredTemplateCapability[]> {
    const rows = await this.database
      .selectFrom('template_capabilities')
      .selectAll()
      .orderBy('id')
      .execute();
    return rows.map(readCapability);
  }

  public async get(id: string): Promise<StoredTemplateCapability | undefined> {
    const row = await this.database
      .selectFrom('template_capabilities')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : readCapability(row);
  }

  public async create(configValue: TemplateCapabilityConfig): Promise<StoredTemplateCapability> {
    const config = templateCapabilityConfigSchema.parse(configValue);
    const timestamp = new Date().toISOString();
    const row: TemplateCapabilityTable = {
      id: config.id,
      config_json: JSON.stringify(config),
      created_at: timestamp,
      updated_at: timestamp,
    };
    await this.database.insertInto('template_capabilities').values(row).executeTakeFirstOrThrow();
    return readCapability(row);
  }

  public async update(
    id: string,
    configValue: TemplateCapabilityConfig,
  ): Promise<StoredTemplateCapability | undefined> {
    const config = templateCapabilityConfigSchema.parse(configValue);
    if (config.id !== id) {
      throw new TypeError(`Template capability id '${config.id}' does not match '${id}'.`);
    }
    const result = await this.database
      .updateTable('template_capabilities')
      .set({
        config_json: JSON.stringify(config),
        updated_at: new Date().toISOString(),
      })
      .where('id', '=', id)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 0 ? undefined : this.get(id);
  }

  public async delete(id: string): Promise<boolean> {
    const result = await this.database
      .deleteFrom('template_capabilities')
      .where('id', '=', id)
      .executeTakeFirst();
    return Number(result.numDeletedRows) === 1;
  }
}

function readCapability(row: TemplateCapabilityTable): StoredTemplateCapability {
  return {
    config: templateCapabilityConfigSchema.parse(JSON.parse(row.config_json)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
