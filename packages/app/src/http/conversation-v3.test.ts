import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MockProvider } from 'dagent-ai/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { appConfigSchema } from '../config.js';
import { AppRepository } from '../database/repositories.js';
import { createApplication } from './server.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('V3 conversation host boundary', () => {
  it('creates identity-matched V3 documents and explicitly rejects legacy rows', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dagent-conversation-host-'));
    temporaryDirectories.push(directory);
    const app = await createApplication({
      config: appConfigSchema.parse({ dataDirectory: join(directory, 'data') }),
      provider: new MockProvider([]),
      logger: false,
    });
    const repository = new AppRepository(app.database);
    const project = await repository.createProject({ name: 'V3', rootPath: directory });
    const conversation = await repository.createConversation({
      projectId: project.id,
      title: 'Canonical',
    });

    expect(conversation.schemaVersion).toBe(3);
    expect(conversation.conversation?.id).toBe(conversation.id);
    await app.database
      .updateTable('conversations')
      .set({
        schema_version: 0,
        conversation_json: JSON.stringify({ schemaVersion: 2, id: conversation.id }),
      })
      .where('id', '=', conversation.id)
      .execute();

    const detail = await app.server.inject({
      method: 'GET',
      url: `/api/v1/conversations/${conversation.id}`,
    });
    const list = await app.server.inject({
      method: 'GET',
      url: `/api/v1/conversations?projectId=${project.id}`,
    });

    expect(detail.statusCode).toBe(409);
    expect(detail.json()).toMatchObject({
      error: { code: 'LEGACY_CONVERSATION' },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([
      expect.objectContaining({
        id: conversation.id,
        schemaVersion: 'legacy',
      }),
    ]);
    await app.close();
  });
});
