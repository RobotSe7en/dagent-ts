import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MockProvider } from 'dagent-ai/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { appConfigSchema } from '../config.js';
import { createApplication } from './server.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('HTTP application', () => {
  it('creates project and conversation resources through versioned routes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dagent-http-'));
    temporaryDirectories.push(directory);
    const config = appConfigSchema.parse({ dataDirectory: directory });
    const application = await createApplication({
      config,
      provider: new MockProvider([]),
      logger: false,
    });

    const health = await application.server.inject({
      method: 'GET',
      url: '/api/v1/health',
    });
    const projectResponse = await application.server.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: 'Example', rootPath: join(directory, 'workspace') },
    });
    const project = projectResponse.json<{ id: string }>();
    const conversationResponse = await application.server.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      payload: { projectId: project.id, title: 'First conversation' },
    });

    expect(health.statusCode).toBe(200);
    expect(projectResponse.statusCode).toBe(201);
    expect(conversationResponse.statusCode).toBe(201);
    expect(
      conversationResponse.json<{ conversation: { items: unknown[] } }>().conversation.items,
    ).toEqual([]);
    await application.close();
  });

  it('lists packaged/configured profiles and manages editable profiles', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dagent-http-profiles-'));
    temporaryDirectories.push(directory);
    const configured = join(directory, 'configured-profiles');
    await mkdir(join(configured, 'broken.md'), { recursive: true });
    await writeFile(join(configured, 'reviewer.md'), '# Reviewer\n\nReview carefully.');
    const config = appConfigSchema.parse({
      dataDirectory: directory,
      profiles: { directory: configured },
    });
    const application = await createApplication({
      config,
      provider: new MockProvider([]),
      logger: false,
    });

    const initial = await application.server.inject({
      method: 'GET',
      url: '/api/v1/profiles',
    });
    const created = await application.server.inject({
      method: 'POST',
      url: '/api/v1/profiles',
      payload: { name: 'analyst', content: '# Analyst\n\nRead carefully.' },
    });
    const updated = await application.server.inject({
      method: 'PUT',
      url: '/api/v1/profiles/analyst',
      payload: { content: '# Analyst\n\nUse terse answers.' },
    });
    const duplicateBuiltin = await application.server.inject({
      method: 'POST',
      url: '/api/v1/profiles',
      payload: { name: 'conversation', content: '# Shadow' },
    });
    const invalid = await application.server.inject({
      method: 'POST',
      url: '/api/v1/profiles',
      payload: { name: '../bad', content: '# Bad' },
    });
    const deleted = await application.server.inject({
      method: 'DELETE',
      url: '/api/v1/profiles/analyst',
    });

    const initialPayload = initial.json<{
      profiles: { source: string; name: string; editable: boolean }[];
      warnings: { name: string }[];
    }>();
    expect(initial.statusCode).toBe(200);
    expect(initialPayload.profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'builtin', name: 'conversation', editable: false }),
        expect.objectContaining({ source: 'config', name: 'reviewer', editable: false }),
      ]),
    );
    expect(initialPayload.warnings).toEqual([expect.objectContaining({ name: 'broken' })]);
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      profile: { source: 'managed', name: 'analyst', editable: true },
    });
    expect(updated.json()).toMatchObject({
      profile: { content: '# Analyst\n\nUse terse answers.' },
    });
    expect(duplicateBuiltin.statusCode).toBe(400);
    expect(invalid.statusCode).toBe(400);
    expect(deleted.statusCode).toBe(204);
    await application.close();
  });

  it('persists saved DAGs with optimistic revisions and soft deletion', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dagent-http-dags-'));
    temporaryDirectories.push(directory);
    const application = await createApplication({
      config: appConfigSchema.parse({ dataDirectory: directory }),
      provider: new MockProvider([]),
      logger: false,
    });
    const projectResponse = await application.server.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: 'DAG project', rootPath: join(directory, 'workspace') },
    });
    const projectId = projectResponse.json<{ id: string }>().id;
    const conversationResponse = await application.server.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      payload: { projectId, title: 'DAG session' },
    });
    const conversationId = conversationResponse.json<{ id: string }>().id;
    const graph = {
      schemaVersion: 1,
      id: 'report_graph',
      name: 'Report graph',
      nodes: [],
      edges: [],
      artifacts: {},
    };

    const created = await application.server.inject({
      method: 'POST',
      url: '/api/v1/saved-dags',
      payload: {
        projectId,
        name: 'Report',
        description: 'Initial',
        graph,
        layout: { zoom: 1 },
      },
    });
    const saved = created.json<{ savedDag: { id: string; revision: number } }>().savedDag;
    const updated = await application.server.inject({
      method: 'PATCH',
      url: `/api/v1/saved-dags/${saved.id}`,
      payload: { expectedRevision: 0, name: 'Updated report' },
    });
    const stale = await application.server.inject({
      method: 'PATCH',
      url: `/api/v1/saved-dags/${saved.id}`,
      payload: { expectedRevision: 0, name: 'Stale update' },
    });
    const listed = await application.server.inject({
      method: 'GET',
      url: `/api/v1/saved-dags?projectId=${projectId}`,
    });
    const sessionCreated = await application.server.inject({
      method: 'POST',
      url: '/api/v1/orchestration-sessions',
      payload: {
        projectId,
        conversationId,
        kind: 'static-dag',
        savedDagId: saved.id,
        uiState: { surface: 'canvas' },
      },
    });
    const session = sessionCreated.json<{ session: { id: string } }>().session;
    const sessionUpdated = await application.server.inject({
      method: 'PATCH',
      url: `/api/v1/orchestration-sessions/${session.id}`,
      payload: { expectedRevision: 0, uiState: { surface: 'workbench' } },
    });
    const sessionByConversation = await application.server.inject({
      method: 'GET',
      url: `/api/v1/conversations/${conversationId}/orchestration-session`,
    });
    const startedRun = await application.server.inject({
      method: 'POST',
      url: `/api/v1/saved-dags/${saved.id}/runs`,
      payload: {
        conversationId,
        orchestrationSessionId: session.id,
        graphInput: {},
      },
    });
    const sessionRuns = await application.server.inject({
      method: 'GET',
      url: `/api/v1/orchestration-sessions/${session.id}/runs`,
    });
    const deleted = await application.server.inject({
      method: 'DELETE',
      url: `/api/v1/saved-dags/${saved.id}`,
    });
    const afterDelete = await application.server.inject({
      method: 'GET',
      url: `/api/v1/saved-dags/${saved.id}`,
    });

    expect(created.statusCode).toBe(201);
    expect(saved.revision).toBe(0);
    expect(updated.json()).toMatchObject({
      savedDag: { name: 'Updated report', revision: 1 },
    });
    expect(stale.statusCode).toBe(409);
    expect(listed.json()).toMatchObject({
      savedDags: [expect.objectContaining({ id: saved.id, projectId })],
    });
    expect(sessionCreated.statusCode).toBe(201);
    expect(sessionUpdated.json()).toMatchObject({
      session: { revision: 1, uiState: { surface: 'workbench' } },
    });
    expect(sessionByConversation.json()).toMatchObject({
      session: { id: session.id, savedDagId: saved.id },
    });
    expect(startedRun.statusCode).toBe(202);
    expect(sessionRuns.json()).toMatchObject({
      runs: [
        expect.objectContaining({
          savedDagId: saved.id,
          orchestrationSessionId: session.id,
        }),
      ],
    });
    expect(deleted.statusCode).toBe(204);
    expect(afterDelete.statusCode).toBe(404);
    await application.close();
  });

  it('manages project files without allowing workspace escape', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dagent-http-files-'));
    temporaryDirectories.push(directory);
    const projectRoot = join(directory, 'project');
    const outside = join(directory, 'outside');
    await mkdir(outside);
    const application = await createApplication({
      config: appConfigSchema.parse({ dataDirectory: join(directory, 'data') }),
      provider: new MockProvider([]),
      logger: false,
    });
    const projectResponse = await application.server.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: 'Files', rootPath: projectRoot },
    });
    const projectId = projectResponse.json<{ id: string }>().id;

    const directoryResponse = await application.server.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/directories`,
      payload: { path: 'docs' },
    });
    const created = await application.server.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/files`,
      payload: { path: 'docs/readme.md', content: '# Hello' },
    });
    const conflict = await application.server.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/files`,
      payload: { path: 'docs/readme.md', content: 'duplicate' },
    });
    const binary = await application.server.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/files`,
      payload: { path: 'image.bin', contentBase64: 'AAEC/w==' },
    });
    const inspected = await application.server.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/files?path=docs%2Freadme.md`,
    });
    const downloaded = await application.server.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/files/download?path=image.bin`,
    });
    const moved = await application.server.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${projectId}/files`,
      payload: { source: 'docs/readme.md', destination: 'docs/guide.md' },
    });
    const escaped = await application.server.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/files`,
      payload: { path: '../escape.txt', content: 'unsafe' },
    });

    await symlink(outside, join(projectRoot, 'linked'));
    const linkedEscape = await application.server.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/files`,
      payload: { path: 'linked/new/file.txt', content: 'unsafe' },
    });
    const deleted = await application.server.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${projectId}/files?path=docs&recursive=true`,
    });

    expect(directoryResponse.statusCode).toBe(201);
    expect(created.statusCode).toBe(201);
    expect(conflict.statusCode).toBe(409);
    expect(binary.statusCode).toBe(201);
    expect(inspected.json()).toMatchObject({
      path: 'docs/readme.md',
      type: 'file',
      content: '# Hello',
      mediaType: 'text/markdown; charset=utf-8',
    });
    expect(downloaded.rawPayload).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(moved.json()).toMatchObject({
      entry: { path: 'docs/guide.md', type: 'file' },
    });
    expect(escaped.statusCode).toBe(400);
    expect(escaped.json()).toMatchObject({ error: { code: 'WORKSPACE_VIOLATION' } });
    expect(linkedEscape.statusCode).toBe(400);
    await expect(access(join(outside, 'new'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(deleted.statusCode).toBe(204);
    await application.close();
  });
});
