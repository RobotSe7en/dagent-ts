import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createFileTools } from './capabilities/file-tools.js';
import { tool } from './capabilities/tool.js';
import { defineStaticDag } from './contracts/agents.js';
import { Runner } from './runner.js';

const runnerPaths = {
  workspace: '/tmp/dagent-ts-artifact-tests',
  runtimeDirectory: '.runtime',
} as const;
import { MockProvider } from './testing/mock-provider.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('Runner static DAG artifacts', () => {
  it('tracks a capability-created artifact in the final checkpoint', async () => {
    const workspacePath = await temporaryRoot();
    const runner = new Runner({
      ...runnerPaths,
      provider: new MockProvider([]),
      capabilities: createFileTools(),
    });
    const target = defineStaticDag({
      schemaVersion: 1,
      id: 'write_report',
      name: 'Write report',
      artifacts: {
        report: { id: 'report', paths: ['outputs/report.md'] },
      },
      nodes: [
        {
          id: 'write',
          kind: 'capability',
          capabilityId: 'tool.write_file',
          arguments: {
            path: {
              $expr: { type: 'artifact', artifactId: 'report', field: 'path' },
            },
            content: 'complete',
          },
          artifactOutputs: ['report'],
        },
      ],
      edges: [],
    });

    const outcome = await runner.run(target, { graphInput: {} }, { workspacePath });

    expect(outcome.status).toBe('completed');
    expect(outcome.state.artifactStates.report).toEqual({
      id: 'report',
      paths: ['outputs/report.md'],
      status: 'created',
      producerNodeId: 'write',
    });
    await expect(readFile(join(workspacePath, 'outputs/report.md'), 'utf8')).resolves.toBe(
      'complete',
    );
    await runner.close();
  });

  it('fails required missing outputs while preserving completed node state', async () => {
    const workspacePath = await temporaryRoot();
    const echo = tool({
      id: 'tool.echo',
      input: z.object({ text: z.string() }).strict(),
      output: z.string(),
      execute: ({ text }) => text,
    });
    const runner = new Runner({
      ...runnerPaths,
      provider: new MockProvider([]),
      capabilities: [echo],
    });
    const target = defineStaticDag({
      schemaVersion: 1,
      id: 'missing_report',
      name: 'Missing report',
      artifacts: {
        report: { id: 'report', paths: ['outputs/report.md'] },
      },
      nodes: [
        {
          id: 'answer',
          kind: 'capability',
          capabilityId: 'tool.echo',
          arguments: { text: 'done' },
          artifactOutputs: ['report'],
        },
      ],
      edges: [],
    });

    const outcome = await runner.run(target, { graphInput: {} }, { workspacePath });

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error(`Unexpected status: ${outcome.status}`);
    expect(outcome.error).toContain('required DAG artifacts');
    expect(outcome.state.nodeResults.answer?.status).toBe('completed');
    expect(outcome.state.artifactStates.report).toMatchObject({
      status: 'missing',
      producerNodeId: 'answer',
    });
    await runner.close();
  });

  it('allows an optional output to remain missing', async () => {
    const workspacePath = await temporaryRoot();
    const noop = tool({
      id: 'tool.noop',
      input: z.object({}).strict(),
      output: z.null(),
      execute: () => null,
    });
    const runner = new Runner({
      ...runnerPaths,
      provider: new MockProvider([]),
      capabilities: [noop],
    });
    const target = defineStaticDag({
      schemaVersion: 1,
      id: 'optional_report',
      name: 'Optional report',
      artifacts: {
        report: {
          id: 'report',
          paths: ['outputs/report.md'],
          required: false,
        },
      },
      nodes: [
        {
          id: 'work',
          kind: 'capability',
          capabilityId: 'tool.noop',
          arguments: {},
          artifactOutputs: ['report'],
        },
      ],
      edges: [],
    });

    const outcome = await runner.run(target, { graphInput: {} }, { workspacePath });

    expect(outcome.status).toBe('completed');
    expect(outcome.state.artifactStates.report?.status).toBe('missing');
    await runner.close();
  });

  it('materializes uploads before review and resumes without serializing file bytes', async () => {
    const workspacePath = await temporaryRoot();
    const runner = new Runner({
      ...runnerPaths,
      provider: new MockProvider([]),
      capabilities: createFileTools(),
    });
    const target = defineStaticDag(
      {
        schemaVersion: 1,
        id: 'read_upload',
        name: 'Read upload',
        artifacts: {
          source: { id: 'source', paths: ['inputs/source.md'] },
        },
        nodes: [
          {
            id: 'read',
            kind: 'capability',
            capabilityId: 'tool.read_file',
            arguments: {
              path: {
                $expr: { type: 'artifact', artifactId: 'source', field: 'path' },
              },
            },
            artifactInputs: ['source'],
          },
        ],
        edges: [],
      },
      'always',
    );

    const pending = await runner.run(
      target,
      {
        graphInput: {},
        artifactUploads: {
          source: [{ filename: 'upload.md', content: Buffer.from('uploaded-data') }],
        },
      },
      { workspacePath },
    );

    expect(pending.status).toBe('awaiting-review');
    if (pending.status !== 'awaiting-review') return;
    expect(pending.state.artifactStates.source?.status).toBe('created');
    expect(pending.state.inputArtifactFiles).toEqual([
      {
        artifactId: 'source',
        files: [{ path: 'inputs/source.md', name: 'source.md', size: 13 }],
      },
    ]);
    expect(JSON.stringify(pending.checkpoint)).not.toContain('uploaded-data');

    const completed = await runner.resume(pending.checkpoint, {
      reviewId: pending.review.id,
      revision: pending.review.revision,
      action: 'approve',
      reason: '',
    });

    expect(completed.status).toBe('completed');
    if (completed.status !== 'completed') {
      throw new Error(`Unexpected status: ${completed.status}`);
    }
    expect(completed.output).toEqual({
      path: 'inputs/source.md',
      content: 'uploaded-data',
    });
    await runner.close();
  });

  it('resolves artifact.files from the upload-time manifest in deterministic order', async () => {
    const workspacePath = await temporaryRoot();
    const listFiles = tool({
      id: 'tool.list_manifest',
      input: z
        .object({
          files: z.array(
            z
              .object({
                path: z.string(),
                name: z.string(),
                size: z.number(),
                mediaType: z.string().optional(),
              })
              .strict(),
          ),
        })
        .strict(),
      output: z.array(
        z
          .object({
            path: z.string(),
            name: z.string(),
            size: z.number(),
            mediaType: z.string().optional(),
          })
          .strict(),
      ),
      execute: ({ files }) => files,
    });
    const runner = new Runner({
      ...runnerPaths,
      provider: new MockProvider([]),
      capabilities: [listFiles],
    });
    const target = defineStaticDag({
      schemaVersion: 1,
      id: 'manifest_files',
      name: 'Manifest files',
      artifacts: {
        source: { id: 'source', paths: ['inputs/source/'], required: false },
      },
      nodes: [
        {
          id: 'list',
          kind: 'capability',
          capabilityId: 'tool.list_manifest',
          arguments: {
            files: {
              $expr: { type: 'artifact', artifactId: 'source', field: 'files', path: [] },
            },
          },
          artifactInputs: ['source'],
        },
      ],
      edges: [],
    });

    const outcome = await runner.run(
      target,
      {
        graphInput: {},
        artifactUploads: {
          source: [
            { filename: 'z.txt', content: Buffer.from('z') },
            {
              filename: 'nested/a.md',
              content: Buffer.from('first'),
              mediaType: 'text/markdown',
            },
          ],
        },
      },
      { workspacePath },
    );

    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') throw new Error(`Unexpected status: ${outcome.status}`);
    expect(outcome.output).toEqual([
      {
        path: 'inputs/source/nested/a.md',
        name: 'a.md',
        size: 5,
        mediaType: 'text/markdown',
      },
      { path: 'inputs/source/z.txt', name: 'z.txt', size: 1 },
    ]);
    await runner.close();
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dagent-run-artifacts-'));
  temporaryRoots.push(root);
  return root;
}
