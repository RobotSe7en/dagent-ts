import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { Workspace } from './workspace.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('Workspace', () => {
  it('rejects an existing path that escapes through a symbolic link', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'dagent-workspace-'));
    temporaryDirectories.push(parent);
    const root = join(parent, 'root');
    const outside = join(parent, 'outside.txt');
    const workspace = await Workspace.open(root);
    await writeFile(outside, 'secret', 'utf8');
    await symlink(outside, join(root, 'linked.txt'));

    await expect(workspace.resolveExisting('linked.txt')).rejects.toThrow(/escapes workspace/u);
    await expect(workspace.ensureParent('linked.txt')).rejects.toThrow(/symbolic link/u);
  });

  it('does not create directories through a symbolic link that leaves the workspace', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'dagent-workspace-'));
    temporaryDirectories.push(parent);
    const root = join(parent, 'root');
    const outside = join(parent, 'outside');
    const workspace = await Workspace.open(root);
    await mkdir(outside);
    await symlink(outside, join(root, 'linked'));

    await expect(workspace.writeFile('linked/new/file.txt', 'unsafe')).rejects.toThrow(
      /escapes workspace/u,
    );
    await expect(readFile(join(outside, 'new', 'file.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('writes atomically and honours the overwrite policy', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'dagent-workspace-'));
    temporaryDirectories.push(parent);
    const workspace = await Workspace.open(join(parent, 'root'));

    await workspace.writeFile('nested/file.txt', 'first', { overwrite: false });
    await expect(
      workspace.writeFile('nested/file.txt', 'second', { overwrite: false }),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    await workspace.writeFile('nested/file.txt', 'replacement');

    await expect(readFile(join(workspace.root, 'nested', 'file.txt'), 'utf8')).resolves.toBe(
      'replacement',
    );
  });
});
