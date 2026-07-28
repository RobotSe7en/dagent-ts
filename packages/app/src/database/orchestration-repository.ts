import type { DAGSpec, JsonObject } from 'dagent-ai';
import { DagentError } from 'dagent-ai';
import { dagSpecSchema, jsonObjectSchema } from 'dagent-ai/contracts';

import type { AppDatabase } from './database.js';
import type { OrchestrationSessionTable } from './schema.js';

export type OrchestrationKind = 'tool-agent' | 'dag-agent' | 'static-dag';

export type OrchestrationSession = {
  readonly id: string;
  readonly conversationId: string;
  readonly projectId: string;
  readonly kind: OrchestrationKind;
  readonly savedDagId?: string;
  readonly draftGraph?: DAGSpec;
  readonly uiState: JsonObject;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export class OrchestrationRepository {
  public constructor(private readonly database: AppDatabase) {}

  public async create(input: {
    readonly conversationId: string;
    readonly projectId: string;
    readonly kind: OrchestrationKind;
    readonly savedDagId?: string;
    readonly draftGraph?: DAGSpec;
    readonly uiState?: JsonObject;
  }): Promise<OrchestrationSession> {
    if ((await this.getByConversation(input.conversationId)) !== undefined) {
      throw new DagentError(
        'CONCURRENCY_CONFLICT',
        `Conversation '${input.conversationId}' already has an orchestration session.`,
      );
    }
    const timestamp = new Date().toISOString();
    const row: OrchestrationSessionTable = {
      id: `orchestration_${crypto.randomUUID()}`,
      conversation_id: input.conversationId,
      project_id: input.projectId,
      kind: input.kind,
      saved_dag_id: input.savedDagId ?? null,
      draft_graph_json:
        input.draftGraph === undefined
          ? null
          : JSON.stringify(dagSpecSchema.parse(input.draftGraph)),
      ui_state_json: JSON.stringify(jsonObjectSchema.parse(input.uiState ?? {})),
      revision: 0,
      created_at: timestamp,
      updated_at: timestamp,
    };
    await this.database.insertInto('orchestration_sessions').values(row).executeTakeFirstOrThrow();
    return readSession(row);
  }

  public async get(id: string): Promise<OrchestrationSession | undefined> {
    const row = await this.database
      .selectFrom('orchestration_sessions')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : readSession(row);
  }

  public async getByConversation(
    conversationId: string,
  ): Promise<OrchestrationSession | undefined> {
    const row = await this.database
      .selectFrom('orchestration_sessions')
      .selectAll()
      .where('conversation_id', '=', conversationId)
      .executeTakeFirst();
    return row === undefined ? undefined : readSession(row);
  }

  public async update(
    id: string,
    input: {
      readonly expectedRevision: number;
      readonly savedDagId?: string | null;
      readonly draftGraph?: DAGSpec | null;
      readonly uiState?: JsonObject;
    },
  ): Promise<OrchestrationSession | undefined> {
    const existing = await this.get(id);
    if (existing === undefined) return undefined;
    const result = await this.database
      .updateTable('orchestration_sessions')
      .set({
        ...(!Object.hasOwn(input, 'savedDagId') ? {} : { saved_dag_id: input.savedDagId ?? null }),
        ...(!Object.hasOwn(input, 'draftGraph')
          ? {}
          : {
              draft_graph_json:
                input.draftGraph === null || input.draftGraph === undefined
                  ? null
                  : JSON.stringify(dagSpecSchema.parse(input.draftGraph)),
            }),
        ...(input.uiState === undefined
          ? {}
          : { ui_state_json: JSON.stringify(jsonObjectSchema.parse(input.uiState)) }),
        revision: existing.revision + 1,
        updated_at: new Date().toISOString(),
      })
      .where('id', '=', id)
      .where('revision', '=', input.expectedRevision)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) !== 1) {
      throw new DagentError(
        'CONCURRENCY_CONFLICT',
        `Orchestration session '${id}' changed since revision ${input.expectedRevision}.`,
      );
    }
    return this.get(id);
  }
}

function readSession(row: OrchestrationSessionTable): OrchestrationSession {
  const kind = orchestrationKind(row.kind);
  return {
    id: row.id,
    conversationId: row.conversation_id,
    projectId: row.project_id,
    kind,
    ...(row.saved_dag_id === null ? {} : { savedDagId: row.saved_dag_id }),
    ...(row.draft_graph_json === null
      ? {}
      : { draftGraph: dagSpecSchema.parse(JSON.parse(row.draft_graph_json)) }),
    uiState: jsonObjectSchema.parse(JSON.parse(row.ui_state_json)),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function orchestrationKind(value: string): OrchestrationKind {
  if (value === 'tool-agent' || value === 'dag-agent' || value === 'static-dag') return value;
  throw new DagentError('INVALID_INPUT', `Stored orchestration kind '${value}' is invalid.`);
}
