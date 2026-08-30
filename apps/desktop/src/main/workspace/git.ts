import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { Workspace } from 'dagent-ai';

import type { GitFileStatus } from '../../shared/contracts.js';

const execFileAsync = promisify(execFile);

export async function gitStatus(root: string): Promise<readonly GitFileStatus[]> {
  const { stdout } = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const records = stdout.split('\0');
  const statuses: GitFileStatus[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record.length < 4) continue;
    const indexStatus = record[0] ?? ' ';
    const workingTree = record[1] ?? ' ';
    const path = record.slice(3);
    const renamed =
      indexStatus === 'R' || indexStatus === 'C' || workingTree === 'R' || workingTree === 'C';
    const originalPath = renamed ? records[++index] : undefined;
    statuses.push({
      path,
      index: indexStatus,
      workingTree,
      ...(originalPath === undefined ? {} : { originalPath }),
    });
  }
  return statuses.sort((left, right) => left.path.localeCompare(right.path));
}

export async function gitDiff(root: string, candidate: string): Promise<string> {
  const workspace = await Workspace.open(root);
  workspace.resolve(candidate);
  const { stdout } = await git(root, ['diff', '--no-ext-diff', '--no-color', '--', candidate]);
  return stdout;
}

async function git(root: string, args: readonly string[]): Promise<{ readonly stdout: string }> {
  try {
    return await execFileAsync('git', [...args], {
      cwd: root,
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Git command failed.';
    throw new Error(`Git inspection failed: ${message}`, { cause: error });
  }
}
