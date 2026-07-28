import { z } from 'zod';

import type { AppDatabase } from './database.js';
import type { CapabilityModuleTable } from './schema.js';

const moduleSourceSchema = z.enum(['path', 'managed']);
const exportNamesSchema = z.array(z.string().trim().min(1)).min(1);

export type CapabilityModuleConfig = {
  readonly id: string;
  readonly source: 'path' | 'managed';
  readonly path: string;
  readonly exports: readonly string[];
  readonly enabled: boolean;
};

export type StoredCapabilityModule = {
  readonly config: CapabilityModuleConfig;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export class CapabilityModuleRepository {
  public constructor(private readonly database: AppDatabase) {}

  public async list(): Promise<readonly StoredCapabilityModule[]> {
    const rows = await this.database
      .selectFrom('capability_modules')
      .selectAll()
      .orderBy('id')
      .execute();
    return rows.map(readModule);
  }

  public async get(id: string): Promise<StoredCapabilityModule | undefined> {
    const row = await this.database
      .selectFrom('capability_modules')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : readModule(row);
  }

  public async create(config: CapabilityModuleConfig): Promise<StoredCapabilityModule> {
    const timestamp = new Date().toISOString();
    const row = writeRow(config, timestamp, timestamp);
    await this.database.insertInto('capability_modules').values(row).executeTakeFirstOrThrow();
    return readModule(row);
  }

  public async update(
    id: string,
    config: CapabilityModuleConfig,
  ): Promise<StoredCapabilityModule | undefined> {
    if (config.id !== id) {
      throw new TypeError(`Capability module id '${config.id}' does not match '${id}'.`);
    }
    const timestamp = new Date().toISOString();
    const result = await this.database
      .updateTable('capability_modules')
      .set({
        source: config.source,
        path: config.path,
        exports_json: JSON.stringify(exportNamesSchema.parse(config.exports)),
        enabled: config.enabled ? 1 : 0,
        updated_at: timestamp,
      })
      .where('id', '=', id)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 0 ? undefined : this.get(id);
  }

  public async delete(id: string): Promise<boolean> {
    const result = await this.database
      .deleteFrom('capability_modules')
      .where('id', '=', id)
      .executeTakeFirst();
    return Number(result.numDeletedRows) === 1;
  }
}

function writeRow(
  config: CapabilityModuleConfig,
  createdAt: string,
  updatedAt: string,
): CapabilityModuleTable {
  return {
    id: config.id,
    source: moduleSourceSchema.parse(config.source),
    path: z.string().min(1).parse(config.path),
    exports_json: JSON.stringify(exportNamesSchema.parse(config.exports)),
    enabled: config.enabled ? 1 : 0,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

function readModule(row: CapabilityModuleTable): StoredCapabilityModule {
  return {
    config: {
      id: row.id,
      source: moduleSourceSchema.parse(row.source),
      path: row.path,
      exports: exportNamesSchema.parse(JSON.parse(row.exports_json)),
      enabled: row.enabled === 1,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
