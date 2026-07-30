import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { capabilityResultSchema, invocationIdSchema } from '../contracts/index.js';
import { normalizeCapabilityResult, readReferencedJsonValue } from './result-storage.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe('V3 result storage', () => {
  it('does not create private storage for a small inline result', async () => {
    const workspacePath = await temporaryDirectory();

    const normalized = await normalizeCapabilityResult(
      capabilityResultSchema.parse({
        invocationId: invocationIdSchema.parse('call-inline'),
        capabilityId: 'tool.produce',
        status: 'completed',
        output: { ok: true },
        content: 'produced',
      }),
      {
        workspacePath,
        runtimeDirectory: '.runtime',
        policy: { maxInlineBytes: 1_024 },
      },
    );

    expect(normalized.valueReference).toBeUndefined();
    await expect(access(join(workspacePath, '.runtime'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('externalizes a large JSON value and restores only an explicitly trusted reference', async () => {
    const workspacePath = await temporaryDirectory();
    const original = { payload: 'z'.repeat(5_000) };
    const normalized = await normalizeCapabilityResult(
      capabilityResultSchema.parse({
        invocationId: invocationIdSchema.parse('call-large'),
        capabilityId: 'tool.produce',
        status: 'completed',
        output: original,
        content: 'produced',
      }),
      {
        workspacePath,
        runtimeDirectory: '.runtime',
        policy: { maxInlineBytes: 1_024 },
      },
    );

    expect(normalized.valueReference).toBeDefined();
    if (normalized.valueReference === undefined) return;
    expect(normalized.result.output).toMatchObject({
      type: 'dagent_content_reference',
    });
    await expect(
      readReferencedJsonValue(normalized.valueReference, workspacePath),
    ).resolves.toEqual(original);
  });

  it('sanitizes untrusted invocation ids and rejects a tampered referenced value', async () => {
    const workspacePath = await temporaryDirectory();
    const normalized = await normalizeCapabilityResult(
      capabilityResultSchema.parse({
        invocationId: invocationIdSchema.parse('../../escape'),
        capabilityId: 'tool.produce',
        status: 'completed',
        output: { payload: 'z'.repeat(5_000) },
        content: 'produced',
      }),
      {
        workspacePath,
        runtimeDirectory: '.runtime',
        policy: { maxInlineBytes: 1_024 },
      },
    );
    const reference = normalized.valueReference;
    expect(reference).toBeDefined();
    if (reference === undefined) return;

    expect(reference.path).toMatch(/^\.runtime\/results\/[A-Za-z0-9_.-]+$/u);
    expect(reference.path).not.toContain('..');
    await writeFile(join(workspacePath, reference.path), '{"tampered":true}');

    await expect(readReferencedJsonValue(reference, workspacePath)).rejects.toMatchObject({
      code: 'DAG_EXECUTION_FAILED',
    });
    await expect(readFile(join(workspacePath, reference.path), 'utf8')).resolves.toBe(
      '{"tampered":true}',
    );
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dagent-results-v3-'));
  temporaryDirectories.push(directory);
  return directory;
}
