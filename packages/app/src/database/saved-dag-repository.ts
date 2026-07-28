import type { DAGSpec, JsonObject } from 'dagent-ai';
import { DagentError } from 'dagent-ai';
import { dagSpecSchema, jsonObjectSchema } from 'dagent-ai/contracts';

import type { AppDatabase } from './database.js';
import type { SavedDagTable } from './schema.js';

export type SavedDag = {
  readonly id: string;
  readonly projectId?: string;
  readonly name: string;
  readonly description: string;
  readonly graph: DAGSpec;
  readonly layout: JsonObject;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export class SavedDagRepository {
  public constructor(private readonly database: AppDatabase) {}

  public async create(input: {
    readonly projectId?: string;
    readonly name: string;
    readonly description?: string;
    readonly graph: DAGSpec;
    readonly layout?: JsonObject;
  }): Promise<SavedDag> {
    const timestamp = new Date().toISOString();
    const row: SavedDagTable = {
      id: `dag_${crypto.randomUUID()}`,
      project_id: input.projectId ?? null,
      name: input.name,
      description: input.description ?? '',
      graph_json: JSON.stringify(dagSpecSchema.parse(input.graph)),
      layout_json: JSON.stringify(jsonObjectSchema.parse(input.layout ?? {})),
      revision: 0,
      archived_at: null,
      created_at: timestamp,
      updated_at: timestamp,
    };
    await this.database.insertInto('saved_dags').values(row).executeTakeFirstOrThrow();
    return readSavedDag(row);
  }

  public async list(projectId?: string): Promise<readonly SavedDag[]> {
    let query = this.database.selectFrom('saved_dags').selectAll().where('archived_at', 'is', null);
    if (projectId !== undefined) query = query.where('project_id', '=', projectId);
    return (await query.orderBy('updated_at', 'desc').execute()).map(readSavedDag);
  }

  public async get(id: string): Promise<SavedDag | undefined> {
    const row = await this.database
      .selectFrom('saved_dags')
      .selectAll()
      .where('id', '=', id)
      .where('archived_at', 'is', null)
      .executeTakeFirst();
    return row === undefined ? undefined : readSavedDag(row);
  }

  public async update(
    id: string,
    input: {
      readonly expectedRevision: number;
      readonly name?: string;
      readonly description?: string;
      readonly graph?: DAGSpec;
      readonly layout?: JsonObject;
    },
  ): Promise<SavedDag | undefined> {
    const existing = await this.get(id);
    if (existing === undefined) return undefined;
    const result = await this.database
      .updateTable('saved_dags')
      .set({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.graph === undefined
          ? {}
          : { graph_json: JSON.stringify(dagSpecSchema.parse(input.graph)) }),
        ...(input.layout === undefined
          ? {}
          : { layout_json: JSON.stringify(jsonObjectSchema.parse(input.layout)) }),
        revision: existing.revision + 1,
        updated_at: new Date().toISOString(),
      })
      .where('id', '=', id)
      .where('revision', '=', input.expectedRevision)
      .where('archived_at', 'is', null)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) !== 1) {
      throw new DagentError(
        'CONCURRENCY_CONFLICT',
        `Saved DAG '${id}' changed since revision ${input.expectedRevision}.`,
      );
    }
    return this.get(id);
  }

  public async archive(id: string): Promise<boolean> {
    const result = await this.database
      .updateTable('saved_dags')
      .set({
        archived_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .where('id', '=', id)
      .where('archived_at', 'is', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }
}

function readSavedDag(row: SavedDagTable): SavedDag {
  return {
    id: row.id,
    ...(row.project_id === null ? {} : { projectId: row.project_id }),
    name: row.name,
    description: row.description,
    graph: dagSpecSchema.parse(JSON.parse(row.graph_json)),
    layout: jsonObjectSchema.parse(JSON.parse(row.layout_json)),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
