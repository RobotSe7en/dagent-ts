import { mkdtemp, rm } from 'node:fs/promises';
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

describe('OnlyOffice integration', () => {
  it('persists redacted settings and serves a signed project document URL', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dagent-onlyoffice-'));
    temporaryDirectories.push(directory);
    const config = appConfigSchema.parse({ dataDirectory: join(directory, 'data') });
    const application = await createApplication({
      config,
      provider: new MockProvider([]),
      logger: false,
    });
    const updated = await application.server.inject({
      method: 'PUT',
      url: '/api/v1/system/onlyoffice',
      payload: {
        config: {
          enabled: true,
          documentServerUrl: 'https://documents.example.test/',
          publicApiBase: 'https://dagent.example.test/',
          jwtSecret: 'document-jwt-secret',
          projectFileEditEnabled: true,
        },
        secretAction: 'replace',
      },
    });
    const project = await application.server.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: 'Documents', rootPath: join(directory, 'project') },
    });
    const projectId = project.json<{ id: string }>().id;
    await application.server.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/files`,
      payload: { path: 'report.docx', content: 'document bytes' },
    });
    const editor = await application.server.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/files/onlyoffice/config?path=report.docx`,
    });
    const editorPayload = editor.json<{
      scriptUrl: string;
      config: {
        token: string;
        document: {
          url: string;
          permissions: { edit: boolean };
        };
      };
    }>();
    const fileUrl = new URL(editorPayload.config.document.url);
    const file = await application.server.inject({
      method: 'GET',
      url: `${fileUrl.pathname}${fileUrl.search}`,
    });
    const idleCallback = await application.server.inject({
      method: 'POST',
      url: fileUrl.pathname.replace('/files/', '/callback/'),
      payload: { status: 1 },
    });
    const invalidToken = await application.server.inject({
      method: 'GET',
      url: '/api/v1/onlyoffice/files/invalid.token',
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.body).not.toContain('document-jwt-secret');
    expect(updated.json()).toMatchObject({
      enabled: true,
      jwtSecretConfigured: true,
    });
    expect(editor.statusCode).toBe(200);
    expect(editorPayload.scriptUrl).toBe(
      'https://documents.example.test/web-apps/apps/api/documents/api.js',
    );
    expect(editorPayload.config.token.split('.')).toHaveLength(3);
    expect(editorPayload.config.document.permissions.edit).toBe(true);
    expect(file.body).toBe('document bytes');
    expect(file.headers['content-disposition']).toContain('inline');
    expect(idleCallback.json()).toEqual({ error: 0 });
    expect(invalidToken.statusCode).toBe(403);
    await application.close();

    const restarted = await createApplication({
      config,
      provider: new MockProvider([]),
      logger: false,
    });
    const persisted = await restarted.server.inject({
      method: 'GET',
      url: '/api/v1/system/onlyoffice',
    });
    expect(persisted.json()).toMatchObject({
      enabled: true,
      jwtSecretConfigured: true,
      projectFileEditEnabled: true,
    });
    expect(persisted.body).not.toContain('document-jwt-secret');
    await restarted.close();
  });

  it('rejects unsupported files and incomplete secret replacement', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dagent-onlyoffice-errors-'));
    temporaryDirectories.push(directory);
    const application = await createApplication({
      config: appConfigSchema.parse({ dataDirectory: join(directory, 'data') }),
      provider: new MockProvider([]),
      logger: false,
    });
    const invalidSettings = await application.server.inject({
      method: 'PUT',
      url: '/api/v1/system/onlyoffice',
      payload: {
        config: {
          enabled: true,
          documentServerUrl: 'https://documents.example.test',
          publicApiBase: 'https://dagent.example.test',
        },
        secretAction: 'replace',
      },
    });
    const project = await application.server.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: 'Documents', rootPath: join(directory, 'project') },
    });
    const projectId = project.json<{ id: string }>().id;
    await application.server.inject({
      method: 'PUT',
      url: '/api/v1/system/onlyoffice',
      payload: {
        config: {
          enabled: true,
          documentServerUrl: 'https://documents.example.test',
          publicApiBase: 'https://dagent.example.test',
        },
        secretAction: 'preserve',
      },
    });
    await application.server.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/files`,
      payload: { path: 'notes.txt', content: 'notes' },
    });
    const unsupported = await application.server.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/files/onlyoffice/config?path=notes.txt`,
    });

    expect(invalidSettings.statusCode).toBe(400);
    expect(unsupported.statusCode).toBe(415);
    await application.close();
  });
});
