import type { ContextUsage, ConversationState, RunCheckpoint, RunEvent, RunId } from 'dagent-ai';
import {
  conversationStateSchema,
  contextUsageSchema,
  runCheckpointSchema,
  runEventSchema,
} from 'dagent-ai/contracts';
import { z } from 'zod';

import type { AppDatabase } from './database.js';
import type { ConversationTable, ProjectTable, RunTable } from './schema.js';
import type { JsonValue } from 'dagent-ai';
import { jsonValueSchema } from 'dagent-ai/contracts';

export type Project = {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly rootPath: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type ConversationKind = 'chat' | 'dynamic-dag' | 'static-dag';

export type Conversation = {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly kind: ConversationKind;
  readonly conversation: ConversationState;
  readonly modelThread?: ConversationState;
  readonly contextUsage: readonly ContextUsage[];
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type StoredRun = {
  readonly id: RunId;
  readonly conversationId?: string;
  readonly savedDagId?: string;
  readonly orchestrationSessionId?: string;
  readonly target: unknown;
  readonly input: unknown;
  readonly checkpoint?: RunCheckpoint;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export class AppRepository {
  public constructor(private readonly database: AppDatabase) {}

  public async listProjects(): Promise<readonly Project[]> {
    return (
      await this.database.selectFrom('projects').selectAll().orderBy('updated_at', 'desc').execute()
    ).map(readProject);
  }

  public async createProject(input: {
    readonly name: string;
    readonly description?: string;
    readonly rootPath: string;
  }): Promise<Project> {
    const timestamp = new Date().toISOString();
    const row: ProjectTable = {
      id: `project_${crypto.randomUUID()}`,
      name: input.name,
      description: input.description ?? null,
      root_path: input.rootPath,
      created_at: timestamp,
      updated_at: timestamp,
    };
    await this.database.insertInto('projects').values(row).executeTakeFirstOrThrow();
    return readProject(row);
  }

  public async getProject(id: string): Promise<Project | undefined> {
    const row = await this.database
      .selectFrom('projects')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : readProject(row);
  }

  public async updateProject(
    id: string,
    input: {
      readonly name?: string;
      readonly description?: string | null;
      readonly rootPath?: string;
    },
  ): Promise<Project | undefined> {
    if (Object.keys(input).length === 0) return this.getProject(id);
    const result = await this.database
      .updateTable('projects')
      .set({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.rootPath === undefined ? {} : { root_path: input.rootPath }),
        updated_at: new Date().toISOString(),
      })
      .where('id', '=', id)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 0 ? undefined : this.getProject(id);
  }

  public async deleteProject(id: string): Promise<boolean> {
    return this.database.transaction().execute(async (transaction) => {
      const conversations = await transaction
        .selectFrom('conversations')
        .select('id')
        .where('project_id', '=', id)
        .execute();
      if (conversations.length > 0) {
        await transaction
          .deleteFrom('runs')
          .where(
            'conversation_id',
            'in',
            conversations.map(({ id: conversationId }) => conversationId),
          )
          .execute();
      }
      const result = await transaction
        .deleteFrom('projects')
        .where('id', '=', id)
        .executeTakeFirst();
      return Number(result.numDeletedRows) === 1;
    });
  }

  public async listConversations(projectId: string): Promise<readonly Conversation[]> {
    const rows = await this.database
      .selectFrom('conversations')
      .selectAll()
      .where('project_id', '=', projectId)
      .orderBy('updated_at', 'desc')
      .execute();
    return rows.map(readConversation);
  }

  public async listAllConversations(): Promise<readonly Conversation[]> {
    const rows = await this.database
      .selectFrom('conversations')
      .selectAll()
      .orderBy('updated_at', 'desc')
      .execute();
    return rows.map(readConversation);
  }

  public async createConversation(input: {
    readonly projectId: string;
    readonly title: string;
    readonly kind?: ConversationKind;
  }): Promise<Conversation> {
    const timestamp = new Date().toISOString();
    const conversation = conversationStateSchema.parse({ schemaVersion: 3 });
    const row: ConversationTable = {
      id: `conversation_${crypto.randomUUID()}`,
      project_id: input.projectId,
      title: input.title,
      kind: input.kind ?? 'chat',
      schema_version: 1,
      conversation_json: JSON.stringify(conversation),
      model_thread_json: null,
      context_usage_json: '[]',
      revision: 0,
      created_at: timestamp,
      updated_at: timestamp,
    };
    await this.database.insertInto('conversations').values(row).executeTakeFirstOrThrow();
    return readConversation(row);
  }

  public async getConversation(id: string): Promise<Conversation | undefined> {
    const row = await this.database
      .selectFrom('conversations')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : readConversation(row);
  }

  public async deleteConversation(id: string): Promise<boolean> {
    return this.database.transaction().execute(async (transaction) => {
      await transaction.deleteFrom('runs').where('conversation_id', '=', id).execute();
      const result = await transaction
        .deleteFrom('conversations')
        .where('id', '=', id)
        .executeTakeFirst();
      return Number(result.numDeletedRows) === 1;
    });
  }

  public async updateConversationTitle(
    id: string,
    title: string,
  ): Promise<Conversation | undefined> {
    const result = await this.database
      .updateTable('conversations')
      .set({ title, updated_at: new Date().toISOString() })
      .where('id', '=', id)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 0 ? undefined : this.getConversation(id);
  }

  public async updateConversationFromCheckpoint(
    id: string,
    checkpoint: RunCheckpoint,
  ): Promise<void> {
    if (checkpoint.state.conversation === undefined) return;
    await this.database
      .updateTable('conversations')
      .set({
        schema_version: checkpoint.state.conversation.schemaVersion,
        conversation_json: JSON.stringify(checkpoint.state.conversation),
        model_thread_json:
          checkpoint.state.modelThread === undefined
            ? null
            : JSON.stringify(checkpoint.state.modelThread),
        context_usage_json: JSON.stringify(checkpoint.state.contextUsage),
        revision: checkpoint.state.conversation.revision,
        updated_at: new Date().toISOString(),
      })
      .where('id', '=', id)
      .execute();
  }

  public async insertRun(input: {
    readonly id: RunId;
    readonly conversationId?: string;
    readonly savedDagId?: string;
    readonly orchestrationSessionId?: string;
    readonly target: unknown;
    readonly runInput: unknown;
  }): Promise<void> {
    const timestamp = new Date().toISOString();
    const row: RunTable = {
      id: input.id,
      conversation_id: input.conversationId ?? null,
      saved_dag_id: input.savedDagId ?? null,
      orchestration_session_id: input.orchestrationSessionId ?? null,
      target_json: JSON.stringify(input.target),
      input_json: JSON.stringify(input.runInput),
      checkpoint_json: null,
      status: 'running',
      created_at: timestamp,
      updated_at: timestamp,
    };
    await this.database.insertInto('runs').values(row).executeTakeFirstOrThrow();
  }

  public async updateRun(id: RunId, status: string, checkpoint?: RunCheckpoint): Promise<void> {
    await this.database
      .updateTable('runs')
      .set({
        status,
        ...(checkpoint === undefined ? {} : { checkpoint_json: JSON.stringify(checkpoint) }),
        updated_at: new Date().toISOString(),
      })
      .where('id', '=', id)
      .execute();
  }

  public async getRun(id: RunId): Promise<StoredRun | undefined> {
    const row = await this.database
      .selectFrom('runs')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : readRun(row);
  }

  public async listRuns(
    filters: {
      readonly projectId?: string;
      readonly conversationId?: string;
      readonly savedDagId?: string;
      readonly orchestrationSessionId?: string;
    } = {},
  ): Promise<readonly StoredRun[]> {
    let query = this.database.selectFrom('runs').selectAll();
    if (filters.conversationId !== undefined) {
      query = query.where('conversation_id', '=', filters.conversationId);
    }
    if (filters.projectId !== undefined) {
      query = query.where(
        'conversation_id',
        'in',
        this.database
          .selectFrom('conversations')
          .select('id')
          .where('project_id', '=', filters.projectId),
      );
    }
    if (filters.savedDagId !== undefined) {
      query = query.where('saved_dag_id', '=', filters.savedDagId);
    }
    if (filters.orchestrationSessionId !== undefined) {
      query = query.where('orchestration_session_id', '=', filters.orchestrationSessionId);
    }
    return (await query.orderBy('created_at', 'desc').execute()).map(readRun);
  }

  public async appendEvent(event: RunEvent): Promise<void> {
    const parsed = runEventSchema.parse(event);
    await this.database
      .insertInto('run_events')
      .values({
        run_id: parsed.runId,
        sequence: parsed.sequence,
        type: parsed.type,
        payload_json: JSON.stringify(parsed),
        created_at: parsed.timestamp,
      })
      .executeTakeFirstOrThrow();
  }

  public async deleteRun(id: RunId): Promise<boolean> {
    const result = await this.database.deleteFrom('runs').where('id', '=', id).executeTakeFirst();
    return Number(result.numDeletedRows) === 1;
  }

  public async eventsAfter(runId: RunId, sequence: number): Promise<readonly RunEvent[]> {
    const rows = await this.database
      .selectFrom('run_events')
      .selectAll()
      .where('run_id', '=', runId)
      .where('sequence', '>', sequence)
      .orderBy('sequence')
      .execute();
    return rows.map(readEvent);
  }

  public async settings(): Promise<Readonly<Record<string, JsonValue>>> {
    const rows = await this.database.selectFrom('settings').selectAll().orderBy('key').execute();
    return Object.fromEntries(
      rows.map((row) => [row.key, jsonValueSchema.parse(JSON.parse(row.value_json))]),
    );
  }

  public async setting(key: string): Promise<JsonValue | undefined> {
    const row = await this.database
      .selectFrom('settings')
      .select('value_json')
      .where('key', '=', key)
      .executeTakeFirst();
    return row === undefined ? undefined : jsonValueSchema.parse(JSON.parse(row.value_json));
  }

  public async setSetting(key: string, value: JsonValue): Promise<void> {
    const timestamp = new Date().toISOString();
    await this.database
      .insertInto('settings')
      .values({
        key,
        value_json: JSON.stringify(jsonValueSchema.parse(value)),
        updated_at: timestamp,
      })
      .onConflict((conflict) =>
        conflict.column('key').doUpdateSet({
          value_json: JSON.stringify(value),
          updated_at: timestamp,
        }),
      )
      .execute();
  }
}

function readConversation(row: ConversationTable): Conversation {
  const modelThread =
    row.model_thread_json === null
      ? undefined
      : conversationStateSchema.parse(JSON.parse(row.model_thread_json));
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    kind: conversationKindSchema.parse(row.kind),
    conversation: conversationStateSchema.parse(JSON.parse(row.conversation_json)),
    ...(modelThread === undefined ? {} : { modelThread }),
    contextUsage: z.array(contextUsageSchema).parse(JSON.parse(row.context_usage_json)),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const conversationKindSchema = z.enum(['chat', 'dynamic-dag', 'static-dag']);

function readProject(row: ProjectTable): Project {
  return {
    id: row.id,
    name: row.name,
    ...(row.description === null ? {} : { description: row.description }),
    rootPath: row.root_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function readRun(row: RunTable): StoredRun {
  return {
    id: row.id as RunId,
    ...(row.conversation_id === null ? {} : { conversationId: row.conversation_id }),
    ...(row.saved_dag_id === null ? {} : { savedDagId: row.saved_dag_id }),
    ...(row.orchestration_session_id === null
      ? {}
      : { orchestrationSessionId: row.orchestration_session_id }),
    target: JSON.parse(row.target_json),
    input: JSON.parse(row.input_json),
    ...(row.checkpoint_json === null
      ? {}
      : { checkpoint: runCheckpointSchema.parse(JSON.parse(row.checkpoint_json)) }),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function readEvent(row: { readonly payload_json: string }): RunEvent {
  return runEventSchema.parse(JSON.parse(row.payload_json));
}
