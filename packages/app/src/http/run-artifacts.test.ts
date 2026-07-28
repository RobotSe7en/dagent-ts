import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MockProvider } from 'dagent-ai/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { appConfigSchema } from '../config.js';
import type { Application } from './server.js';
import { createApplication } from './server.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('run artifact resources', () => {
  it('lists, previews, and downloads declared DAG output files', async () => {
    const application = await testApplication();
    const started = await application.server.inject({
      method: 'POST',
      url: '/api/v1/runs',
      payload: {
        target: {
          kind: 'static-dag',
          reviewLevel: 'never',
          graph: {
            schemaVersion: 1,
            id: 'report',
            name: 'Report',
            nodes: [
              {
                id: 'write',
                kind: 'capability',
                capabilityId: 'tool.write_file',
                arguments: {
                  path: 'out/report.md',
                  content: '# Generated report',
                },
                artifactInputs: [],
                artifactOutputs: ['report'],
              },
            ],
            edges: [],
            artifacts: {
              report: {
                id: 'report',
                paths: ['out/report.md'],
                required: true,
              },
            },
          },
        },
        input: { graphInput: {} },
      },
    });
    const runId = started.json<{ runId: string }>().runId;
    await waitForCompletedRun(application, runId);

    const listed = await application.server.inject({
      method: 'GET',
      url: `/api/v1/runs/${runId}/artifacts`,
    });
    const preview = await application.server.inject({
      method: 'GET',
      url: `/api/v1/runs/${runId}/artifacts/preview?path=out%2Freport.md`,
    });
    const download = await application.server.inject({
      method: 'GET',
      url: `/api/v1/runs/${runId}/artifacts/download?path=out%2Freport.md`,
    });
    const escape = await application.server.inject({
      method: 'GET',
      url: `/api/v1/runs/${runId}/artifacts/download?path=..%2Fsecret`,
    });

    expect(listed.json()).toMatchObject({
      runId,
      states: { report: { status: 'created' } },
      files: [
        expect.objectContaining({
          path: 'out/report.md',
          source: 'dag-artifact',
          artifactId: 'report',
          previewKind: 'markdown',
        }),
      ],
      truncated: false,
    });
    expect(preview.json()).toMatchObject({
      path: 'out/report.md',
      content: '# Generated report',
      truncated: false,
    });
    expect(download.rawPayload.toString('utf8')).toBe('# Generated report');
    expect(download.headers['content-type']).toContain('text/markdown');
    expect(escape.statusCode).toBe(400);
    await application.close();
  });

  it('materializes Base64 artifact uploads without persisting their contents', async () => {
    const application = await testApplication();
    const started = await application.server.inject({
      method: 'POST',
      url: '/api/v1/runs',
      payload: {
        target: {
          kind: 'static-dag',
          reviewLevel: 'never',
          graph: {
            schemaVersion: 1,
            id: 'uploaded_input',
            name: 'Uploaded input',
            nodes: [],
            edges: [],
            artifacts: {
              source: {
                id: 'source',
                paths: ['inputs/source.txt'],
                required: true,
              },
            },
          },
        },
        input: {
          graphInput: {},
          artifactUploads: {
            source: [
              {
                filename: 'source.txt',
                contentBase64: Buffer.from('private upload').toString('base64'),
              },
            ],
          },
        },
      },
    });
    const runId = started.json<{ runId: string }>().runId;
    const run = await waitForCompletedRun(application, runId);
    const download = await application.server.inject({
      method: 'GET',
      url: `/api/v1/runs/${runId}/artifacts/download?path=inputs%2Fsource.txt`,
    });

    expect(run.input).toMatchObject({
      artifactUploads: {
        source: [{ filename: 'source.txt', byteLength: 14 }],
      },
    });
    expect(JSON.stringify(run.input)).not.toContain('private upload');
    expect(download.rawPayload.toString('utf8')).toBe('private upload');
    await application.close();
  });
});

async function testApplication(): Promise<Application> {
  const directory = await mkdtemp(join(tmpdir(), 'dagent-run-artifacts-'));
  temporaryDirectories.push(directory);
  return createApplication({
    config: appConfigSchema.parse({ dataDirectory: join(directory, 'data') }),
    provider: new MockProvider([]),
    logger: false,
  });
}

async function waitForCompletedRun(
  application: Application,
  runId: string,
): Promise<{ status: string; input: unknown }> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await application.server.inject({
      method: 'GET',
      url: `/api/v1/runs/${runId}`,
    });
    const run = response.json<{ status: string; input: unknown }>();
    if (run.status !== 'running') return run;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(`Run '${runId}' did not complete.`);
}
