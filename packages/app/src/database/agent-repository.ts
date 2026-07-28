import type { AutoAgent, DagAgent, ToolAgent } from 'dagent-ai';
import { autoAgentSchema, dagAgentSchema, toolAgentSchema } from 'dagent-ai/contracts';
import { z } from 'zod';

import type { AppDatabase } from './database.js';
import type { AgentTable } from './schema.js';

const agentConfigSchema = z.discriminatedUnion('kind', [
  toolAgentSchema,
  dagAgentSchema,
  autoAgentSchema,
]);

export type AgentConfig = ToolAgent | DagAgent | AutoAgent;

export type StoredAgent = {
  readonly config: AgentConfig;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export class AgentRepository {
  public constructor(private readonly database: AppDatabase) {}

  public async list(): Promise<readonly StoredAgent[]> {
    const rows = await this.database
      .selectFrom('agents')
      .selectAll()
      .orderBy('updated_at', 'desc')
      .execute();
    return rows.map(readAgent);
  }

  public async get(id: string): Promise<StoredAgent | undefined> {
    const row = await this.database
      .selectFrom('agents')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : readAgent(row);
  }

  public async create(configValue: AgentConfig): Promise<StoredAgent> {
    const config = agentConfigSchema.parse(configValue);
    const timestamp = new Date().toISOString();
    const row: AgentTable = {
      id: config.id,
      config_json: JSON.stringify(config),
      created_at: timestamp,
      updated_at: timestamp,
    };
    await this.database.insertInto('agents').values(row).executeTakeFirstOrThrow();
    return readAgent(row);
  }

  public async update(id: string, configValue: AgentConfig): Promise<StoredAgent | undefined> {
    const config = agentConfigSchema.parse(configValue);
    if (config.id !== id) {
      throw new TypeError(`Agent config id '${config.id}' does not match route id '${id}'.`);
    }
    const result = await this.database
      .updateTable('agents')
      .set({
        config_json: JSON.stringify(config),
        updated_at: new Date().toISOString(),
      })
      .where('id', '=', id)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 0 ? undefined : this.get(id);
  }

  public async delete(id: string): Promise<boolean> {
    const result = await this.database.deleteFrom('agents').where('id', '=', id).executeTakeFirst();
    return Number(result.numDeletedRows) === 1;
  }
}

function readAgent(row: AgentTable): StoredAgent {
  return {
    config: agentConfigSchema.parse(JSON.parse(row.config_json)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
