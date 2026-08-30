import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { createTwoFilesPatch } from 'diff';

import type { FileChange, RunChanges } from '../../shared/contracts.js';

const ignoredDirectories = new Set(['.git', '.runtime', 'node_modules', 'dist', 'out', '.vite']);
const maxFiles = 20_000;
const maxContentFileBytes = 256 * 1024;
const maxContentTotalBytes = 8 * 1024 * 1024;
const maxDiffBytes = 200 * 1024;

type SnapshotFile = {
  readonly size: number;
  readonly hash: string;
  readonly content?: string;
};

export type WorkspaceSnapshot = {
  readonly files: ReadonlyMap<string, SnapshotFile>;
  readonly truncated: boolean;
};

export async function scanWorkspace(root: string): Promise<WorkspaceSnapshot> {
  const files = new Map<string, SnapshotFile>();
  let contentBytes = 0;
  let truncated = false;

  async function visit(directory: string): Promise<void> {
    if (truncated) return;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (files.size >= maxFiles) {
        truncated = true;
        return;
      }
      if (entry.isSymbolicLink()) continue;
      const target = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) await visit(target);
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await lstat(target);
      const bytes = await readFile(target);
      const path = relative(root, target).split('\\').join('/');
      const content =
        info.size <= maxContentFileBytes &&
        contentBytes + info.size <= maxContentTotalBytes &&
        !bytes.includes(0)
          ? bytes.toString('utf8')
          : undefined;
      if (content !== undefined) contentBytes += info.size;
      files.set(path, {
        size: info.size,
        hash: createHash('sha256').update(bytes).digest('hex'),
        ...(content === undefined ? {} : { content }),
      });
    }
  }

  await visit(root);
  return { files, truncated };
}

export function compareSnapshots(
  runId: string,
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
): RunChanges {
  const paths = [...new Set([...before.files.keys(), ...after.files.keys()])].sort();
  const files: FileChange[] = [];
  for (const path of paths) {
    const left = before.files.get(path);
    const right = after.files.get(path);
    if (left?.hash === right?.hash) continue;
    const status = left === undefined ? 'added' : right === undefined ? 'deleted' : 'modified';
    const patch = createTextDiff(path, left?.content, right?.content);
    files.push({
      path,
      status,
      ...(left === undefined ? {} : { beforeSize: left.size }),
      ...(right === undefined ? {} : { afterSize: right.size }),
      ...(patch === undefined ? {} : { diff: patch }),
    });
  }
  return {
    runId,
    capturedAt: new Date().toISOString(),
    truncated: before.truncated || after.truncated,
    files,
  };
}

function createTextDiff(
  path: string,
  before: string | undefined,
  after: string | undefined,
): string | undefined {
  if (before === undefined && after === undefined) return undefined;
  const patch = createTwoFilesPatch(
    `a/${path}`,
    `b/${path}`,
    before ?? '',
    after ?? '',
    undefined,
    undefined,
    { context: 3 },
  );
  return Buffer.byteLength(patch) <= maxDiffBytes ? patch : undefined;
}
