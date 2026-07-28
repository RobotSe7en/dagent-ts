import type { McpServerConfig } from 'dagent-ai';
import { mcpServerConfigSchema } from 'dagent-ai';

import type { AppDatabase } from './database.js';
import type { McpServerTable } from './schema.js';

export type StoredMcpServer = {
  readonly config: McpServerConfig;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export class McpServerRepository {
  public constructor(private readonly database: AppDatabase) {}

  public async list(): Promise<readonly StoredMcpServer[]> {
    const rows = await this.database
      .selectFrom('mcp_servers')
      .selectAll()
      .orderBy('name')
      .execute();
    return rows.map(readServer);
  }

  public async get(name: string): Promise<StoredMcpServer | undefined> {
    const row = await this.database
      .selectFrom('mcp_servers')
      .selectAll()
      .where('name', '=', name)
      .executeTakeFirst();
    return row === undefined ? undefined : readServer(row);
  }

  public async create(configValue: McpServerConfig): Promise<StoredMcpServer> {
    const config = mcpServerConfigSchema.parse(configValue);
    const timestamp = new Date().toISOString();
    const row: McpServerTable = {
      name: config.name,
      config_json: JSON.stringify(config),
      created_at: timestamp,
      updated_at: timestamp,
    };
    await this.database.insertInto('mcp_servers').values(row).executeTakeFirstOrThrow();
    return readServer(row);
  }

  public async update(
    name: string,
    configValue: McpServerConfig,
  ): Promise<StoredMcpServer | undefined> {
    const config = mcpServerConfigSchema.parse(configValue);
    if (config.name !== name) {
      throw new TypeError(`MCP config name '${config.name}' does not match route name '${name}'.`);
    }
    const result = await this.database
      .updateTable('mcp_servers')
      .set({
        config_json: JSON.stringify(config),
        updated_at: new Date().toISOString(),
      })
      .where('name', '=', name)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 0 ? undefined : this.get(name);
  }

  public async delete(name: string): Promise<boolean> {
    const result = await this.database
      .deleteFrom('mcp_servers')
      .where('name', '=', name)
      .executeTakeFirst();
    return Number(result.numDeletedRows) === 1;
  }
}

function readServer(row: McpServerTable): StoredMcpServer {
  return {
    config: mcpServerConfigSchema.parse(JSON.parse(row.config_json)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
