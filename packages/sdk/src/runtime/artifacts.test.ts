import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { Artifact, DagNode } from '../contracts/index.js';
import { DagentError } from '../errors.js';
import { validateArtifactPath, validateUploadFilename } from '../domain/artifact-path.js';
import { ArtifactWorkspace } from './artifacts.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('artifact path contracts', () => {
  it.each([
    '/tmp/outside.txt',
    '../outside.txt',
    'safe/../../outside.txt',
    'C:/outside.txt',
    'C:outside.txt',
    String.raw`\\server\share\outside.txt`,
  ])('rejects paths outside the run workspace: %s', (path) => {
    expect(() => validateArtifactPath(path)).toThrow(DagentError);
  });

  it.each([
    '/tmp/source.txt',
    String.raw`\tmp\source.txt`,
    'docs/../source.txt',
    'C:tmp/source.txt',
    String.raw`C:\tmp\source.txt`,
  ])('rejects unsafe upload names: %s', (filename) => {
    expect(() => validateUploadFilename(filename)).toThrow(DagentError);
  });
});

describe('ArtifactWorkspace', () => {
  it('tracks created and missing node outputs', async () => {
    const root = await temporaryRoot();
    const workspace = await ArtifactWorkspace.open({
      workspacePath: root,
      artifacts: {
        report: artifact('report', ['outputs/report.md']),
        bundle: artifact('bundle', ['outputs/bundle/']),
      },
    });
    await mkdir(join(root, 'outputs'), { recursive: true });
    await writeFile(join(root, 'outputs/report.md'), 'done');

    await workspace.refreshOutputs(
      capabilityNode({
        id: 'write',
        artifactOutputs: ['report', 'bundle'],
      }),
    );

    expect(workspace.snapshot()).toEqual({
      report: {
        id: 'report',
        paths: ['outputs/report.md'],
        status: 'created',
        producerNodeId: 'write',
      },
      bundle: {
        id: 'bundle',
        paths: ['outputs/bundle/'],
        status: 'missing',
        producerNodeId: 'write',
        error: 'One or more artifact paths were not created.',
      },
    });
  });

  it('resets stale state when replanning changes artifact paths', async () => {
    const root = await temporaryRoot();
    const workspace = await ArtifactWorkspace.open({
      workspacePath: root,
      artifacts: { report: artifact('report', ['new/report.md']) },
      previousStates: {
        report: {
          id: 'report',
          paths: ['old/report.md'],
          status: 'created',
          producerNodeId: 'old_writer',
        },
      },
    });

    expect(workspace.snapshot().report).toEqual({
      id: 'report',
      paths: ['new/report.md'],
      status: 'planned',
    });
  });

  it('materializes single and directory uploads without escaping', async () => {
    const root = await temporaryRoot();
    const workspace = await ArtifactWorkspace.open({
      workspacePath: root,
      artifacts: {
        spec: artifact('spec', ['inputs/spec.md']),
        bundle: artifact('bundle', ['inputs/bundle/']),
      },
    });

    await workspace.materialize({
      spec: [{ filename: 'source.md', content: Buffer.from('spec') }],
      bundle: [
        { filename: 'docs/a.md', content: Buffer.from('a') },
        { filename: 'images/b.txt', content: Buffer.from('b') },
      ],
    });

    await expect(readFile(join(root, 'inputs/spec.md'), 'utf8')).resolves.toBe('spec');
    await expect(readFile(join(root, 'inputs/bundle/docs/a.md'), 'utf8')).resolves.toBe('a');
    await expect(readFile(join(root, 'inputs/bundle/images/b.txt'), 'utf8')).resolves.toBe('b');
    expect(workspace.snapshot().spec?.status).toBe('created');
    expect(workspace.snapshot().bundle?.status).toBe('created');
  });

  it('rejects an artifact output that resolves through a symlink escape', async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await symlink(outside, join(root, 'linked'), 'dir');
    const workspace = await ArtifactWorkspace.open({
      workspacePath: root,
      artifacts: { report: artifact('report', ['linked/report.md']) },
    });
    await writeFile(join(outside, 'report.md'), 'outside');

    await expect(
      workspace.refreshOutputs(capabilityNode({ id: 'write', artifactOutputs: ['report'] })),
    ).rejects.toMatchObject({ code: 'WORKSPACE_VIOLATION' });
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dagent-artifacts-'));
  temporaryRoots.push(root);
  return root;
}

function artifact(id: string, paths: readonly string[]): Artifact {
  return {
    id,
    paths: [...paths],
    description: '',
    required: true,
    metadata: {},
  };
}

function capabilityNode(
  values: Partial<Extract<DagNode, { kind: 'capability' }>> & { readonly id: string },
): Extract<DagNode, { kind: 'capability' }> {
  return {
    kind: 'capability',
    description: '',
    capabilityId: 'tool.test',
    arguments: {},
    artifactInputs: [],
    artifactOutputs: [],
    ...values,
  };
}
