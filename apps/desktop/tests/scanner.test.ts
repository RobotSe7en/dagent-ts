import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  compareSnapshots,
  scanWorkspace,
  type WorkspaceSnapshot,
} from '../src/main/workspace/scanner.js';

describe('workspace changes', () => {
  it('reports deterministic before/after changes without apply semantics', () => {
    const before: WorkspaceSnapshot = {
      truncated: false,
      files: new Map([
        ['deleted.txt', { size: 3, hash: 'old', content: 'old' }],
        ['modified.txt', { size: 3, hash: 'left', content: 'one' }],
      ]),
    };
    const after: WorkspaceSnapshot = {
      truncated: false,
      files: new Map([
        ['added.txt', { size: 3, hash: 'new', content: 'new' }],
        ['modified.txt', { size: 3, hash: 'right', content: 'two' }],
      ]),
    };

    const changes = compareSnapshots('run_1', before, after);
    expect(changes.files.map(({ path, status }) => ({ path, status }))).toEqual([
      { path: 'added.txt', status: 'added' },
      { path: 'deleted.txt', status: 'deleted' },
      { path: 'modified.txt', status: 'modified' },
    ]);
    expect(changes.files[2]?.diff).toContain('-one');
    expect(changes.files[2]?.diff).toContain('+two');
  });

  it('hashes files larger than the diff retention limit without retaining their contents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dagent-desktop-scan-'));
    const content = Buffer.alloc(300 * 1024, 7);
    try {
      await writeFile(join(root, 'large.bin'), content);

      const snapshot = await scanWorkspace(root);

      expect(snapshot.files.get('large.bin')).toEqual({
        size: content.byteLength,
        hash: createHash('sha256').update(content).digest('hex'),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
