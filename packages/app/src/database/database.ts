import { chmod, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import Database from 'better-sqlite3';
import { Kysely, SqliteDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';

import type { DatabaseSchema } from './schema.js';

export type AppDatabase = Kysely<DatabaseSchema>;

export async function openDatabase(pathValue: string): Promise<AppDatabase> {
  const path = resolve(pathValue);
  await mkdir(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  await chmod(path, 0o600);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  const database = new Kysely<DatabaseSchema>({
    dialect: new SqliteDialect({ database: sqlite }),
  });
  await migrate(database);
  return database;
}

async function migrate(database: AppDatabase): Promise<void> {
  const migrator = new Migrator({
    db: database,
    provider: {
      async getMigrations() {
        return {
          '001_initial': {
            async up(db) {
              await db.schema
                .createTable('projects')
                .ifNotExists()
                .addColumn('id', 'text', (column) => column.primaryKey())
                .addColumn('name', 'text', (column) => column.notNull())
                .addColumn('root_path', 'text', (column) => column.notNull())
                .addColumn('created_at', 'text', (column) => column.notNull())
                .addColumn('updated_at', 'text', (column) => column.notNull())
                .execute();
              await db.schema
                .createTable('conversations')
                .ifNotExists()
                .addColumn('id', 'text', (column) => column.primaryKey())
                .addColumn('project_id', 'text', (column) =>
                  column.notNull().references('projects.id').onDelete('cascade'),
                )
                .addColumn('title', 'text', (column) => column.notNull())
                .addColumn('schema_version', 'integer', (column) => column.notNull())
                .addColumn('conversation_json', 'text', (column) => column.notNull())
                .addColumn('model_thread_json', 'text')
                .addColumn('context_usage_json', 'text', (column) => column.notNull())
                .addColumn('revision', 'integer', (column) => column.notNull())
                .addColumn('created_at', 'text', (column) => column.notNull())
                .addColumn('updated_at', 'text', (column) => column.notNull())
                .execute();
              await db.schema
                .createIndex('conversations_project_updated')
                .ifNotExists()
                .on('conversations')
                .columns(['project_id', 'updated_at'])
                .execute();
              await db.schema
                .createTable('runs')
                .ifNotExists()
                .addColumn('id', 'text', (column) => column.primaryKey())
                .addColumn('conversation_id', 'text', (column) =>
                  column.references('conversations.id').onDelete('set null'),
                )
                .addColumn('target_json', 'text', (column) => column.notNull())
                .addColumn('input_json', 'text', (column) => column.notNull())
                .addColumn('checkpoint_json', 'text')
                .addColumn('status', 'text', (column) => column.notNull())
                .addColumn('created_at', 'text', (column) => column.notNull())
                .addColumn('updated_at', 'text', (column) => column.notNull())
                .execute();
              await db.schema
                .createTable('run_events')
                .ifNotExists()
                .addColumn('id', 'integer', (column) => column.primaryKey().autoIncrement())
                .addColumn('run_id', 'text', (column) =>
                  column.notNull().references('runs.id').onDelete('cascade'),
                )
                .addColumn('sequence', 'integer', (column) => column.notNull())
                .addColumn('type', 'text', (column) => column.notNull())
                .addColumn('payload_json', 'text', (column) => column.notNull())
                .addColumn('created_at', 'text', (column) => column.notNull())
                .addUniqueConstraint('run_events_run_sequence', ['run_id', 'sequence'])
                .execute();
              await db.schema
                .createIndex('run_events_resume')
                .ifNotExists()
                .on('run_events')
                .columns(['run_id', 'sequence'])
                .execute();
              await db.schema
                .createTable('settings')
                .ifNotExists()
                .addColumn('key', 'text', (column) => column.primaryKey())
                .addColumn('value_json', 'text', (column) => column.notNull())
                .addColumn('updated_at', 'text', (column) => column.notNull())
                .execute();
              await db.schema
                .createTable('leases')
                .ifNotExists()
                .addColumn('resource', 'text', (column) => column.primaryKey())
                .addColumn('holder', 'text', (column) => column.notNull())
                .addColumn('expires_at', 'text', (column) => column.notNull())
                .execute();
            },
            async down(db) {
              await db.schema.dropTable('leases').ifExists().execute();
              await db.schema.dropTable('settings').ifExists().execute();
              await db.schema.dropTable('run_events').ifExists().execute();
              await db.schema.dropTable('runs').ifExists().execute();
              await db.schema.dropTable('conversations').ifExists().execute();
              await db.schema.dropTable('projects').ifExists().execute();
            },
          },
          '002_saved_dags_and_orchestration': {
            async up(db) {
              await db.schema
                .createTable('saved_dags')
                .addColumn('id', 'text', (column) => column.primaryKey())
                .addColumn('project_id', 'text', (column) =>
                  column.references('projects.id').onDelete('cascade'),
                )
                .addColumn('name', 'text', (column) => column.notNull())
                .addColumn('description', 'text', (column) => column.notNull())
                .addColumn('graph_json', 'text', (column) => column.notNull())
                .addColumn('layout_json', 'text', (column) => column.notNull())
                .addColumn('revision', 'integer', (column) => column.notNull())
                .addColumn('archived_at', 'text')
                .addColumn('created_at', 'text', (column) => column.notNull())
                .addColumn('updated_at', 'text', (column) => column.notNull())
                .execute();
              await db.schema
                .createIndex('saved_dags_project_updated')
                .on('saved_dags')
                .columns(['project_id', 'updated_at'])
                .execute();
              await db.schema
                .createTable('orchestration_sessions')
                .addColumn('id', 'text', (column) => column.primaryKey())
                .addColumn('conversation_id', 'text', (column) =>
                  column.notNull().unique().references('conversations.id').onDelete('cascade'),
                )
                .addColumn('project_id', 'text', (column) =>
                  column.notNull().references('projects.id').onDelete('cascade'),
                )
                .addColumn('kind', 'text', (column) => column.notNull())
                .addColumn('saved_dag_id', 'text', (column) =>
                  column.references('saved_dags.id').onDelete('set null'),
                )
                .addColumn('draft_graph_json', 'text')
                .addColumn('ui_state_json', 'text', (column) => column.notNull())
                .addColumn('revision', 'integer', (column) => column.notNull())
                .addColumn('created_at', 'text', (column) => column.notNull())
                .addColumn('updated_at', 'text', (column) => column.notNull())
                .execute();
              await db.schema
                .alterTable('runs')
                .addColumn('saved_dag_id', 'text', (column) =>
                  column.references('saved_dags.id').onDelete('set null'),
                )
                .execute();
              await db.schema
                .alterTable('runs')
                .addColumn('orchestration_session_id', 'text', (column) =>
                  column.references('orchestration_sessions.id').onDelete('set null'),
                )
                .execute();
            },
            async down(db) {
              await db.schema.alterTable('runs').dropColumn('orchestration_session_id').execute();
              await db.schema.alterTable('runs').dropColumn('saved_dag_id').execute();
              await db.schema.dropTable('orchestration_sessions').execute();
              await db.schema.dropTable('saved_dags').execute();
            },
          },
          '003_project_and_conversation_metadata': {
            async up(db) {
              await db.schema.alterTable('projects').addColumn('description', 'text').execute();
              await db.schema
                .alterTable('conversations')
                .addColumn('kind', 'text', (column) => column.notNull().defaultTo('chat'))
                .execute();
            },
            async down(db) {
              await db.schema.alterTable('conversations').dropColumn('kind').execute();
              await db.schema.alterTable('projects').dropColumn('description').execute();
            },
          },
          '004_agent_presets': {
            async up(db) {
              await db.schema
                .createTable('agents')
                .addColumn('id', 'text', (column) => column.primaryKey())
                .addColumn('config_json', 'text', (column) => column.notNull())
                .addColumn('created_at', 'text', (column) => column.notNull())
                .addColumn('updated_at', 'text', (column) => column.notNull())
                .execute();
            },
            async down(db) {
              await db.schema.dropTable('agents').execute();
            },
          },
          '005_model_providers': {
            async up(db) {
              await db.schema
                .createTable('model_providers')
                .addColumn('id', 'text', (column) => column.primaryKey())
                .addColumn('name', 'text', (column) => column.notNull())
                .addColumn('source', 'text', (column) => column.notNull())
                .addColumn('base_url', 'text', (column) => column.notNull())
                .addColumn('model', 'text', (column) => column.notNull())
                .addColumn('api_key', 'text')
                .addColumn('api_key_env', 'text')
                .addColumn('timeout_ms', 'integer', (column) => column.notNull())
                .addColumn('context_window_tokens', 'integer', (column) => column.notNull())
                .addColumn('output_reserve_tokens', 'integer', (column) => column.notNull())
                .addColumn('reasoning_json', 'text', (column) => column.notNull())
                .addColumn('extra_body_json', 'text', (column) => column.notNull())
                .addColumn('active', 'integer', (column) => column.notNull())
                .addColumn('created_at', 'text', (column) => column.notNull())
                .addColumn('updated_at', 'text', (column) => column.notNull())
                .execute();
            },
            async down(db) {
              await db.schema.dropTable('model_providers').execute();
            },
          },
          '006_mcp_servers': {
            async up(db) {
              await db.schema
                .createTable('mcp_servers')
                .addColumn('name', 'text', (column) => column.primaryKey())
                .addColumn('config_json', 'text', (column) => column.notNull())
                .addColumn('created_at', 'text', (column) => column.notNull())
                .addColumn('updated_at', 'text', (column) => column.notNull())
                .execute();
            },
            async down(db) {
              await db.schema.dropTable('mcp_servers').execute();
            },
          },
          '007_capability_modules': {
            async up(db) {
              await db.schema
                .createTable('capability_modules')
                .addColumn('id', 'text', (column) => column.primaryKey())
                .addColumn('source', 'text', (column) => column.notNull())
                .addColumn('path', 'text', (column) => column.notNull())
                .addColumn('exports_json', 'text', (column) => column.notNull())
                .addColumn('enabled', 'integer', (column) => column.notNull())
                .addColumn('created_at', 'text', (column) => column.notNull())
                .addColumn('updated_at', 'text', (column) => column.notNull())
                .execute();
            },
            async down(db) {
              await db.schema.dropTable('capability_modules').execute();
            },
          },
          '008_template_capabilities': {
            async up(db) {
              await db.schema
                .createTable('template_capabilities')
                .addColumn('id', 'text', (column) => column.primaryKey())
                .addColumn('config_json', 'text', (column) => column.notNull())
                .addColumn('created_at', 'text', (column) => column.notNull())
                .addColumn('updated_at', 'text', (column) => column.notNull())
                .execute();
            },
            async down(db) {
              await db.schema.dropTable('template_capabilities').execute();
            },
          },
          '009_v3_conversations': {
            async up(db) {
              await sql`
                update conversations
                set schema_version = case
                  when json_valid(conversation_json)
                    and json_extract(conversation_json, '$.schemaVersion') = 3
                    and json_extract(conversation_json, '$.id') = id
                  then 3
                  else 0
                end
              `.execute(db);
              await db.schema.alterTable('conversations').dropColumn('model_thread_json').execute();
              await db.schema
                .alterTable('conversations')
                .dropColumn('context_usage_json')
                .execute();
            },
            async down(db) {
              await db.schema
                .alterTable('conversations')
                .addColumn('model_thread_json', 'text')
                .execute();
              await db.schema
                .alterTable('conversations')
                .addColumn('context_usage_json', 'text', (column) =>
                  column.notNull().defaultTo('[]'),
                )
                .execute();
            },
          },
          '010_provider_request_options': {
            async up(db) {
              await db.schema
                .alterTable('model_providers')
                .addColumn('stream_include_usage', 'integer', (column) =>
                  column.notNull().defaultTo(0),
                )
                .execute();
              await db.schema
                .alterTable('model_providers')
                .addColumn('extra_request_args_json', 'text', (column) =>
                  column.notNull().defaultTo('{}'),
                )
                .execute();
            },
            async down(db) {
              await db.schema
                .alterTable('model_providers')
                .dropColumn('extra_request_args_json')
                .execute();
              await db.schema
                .alterTable('model_providers')
                .dropColumn('stream_include_usage')
                .execute();
            },
          },
        };
      },
    },
  });
  const result = await migrator.migrateToLatest();
  const error = result.error;
  if (error !== undefined) {
    throw error instanceof Error
      ? error
      : new Error('Database migration failed.', { cause: error });
  }
}
