import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SkillStore } from './store.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('SkillStore', () => {
  it('installs, discovers, confines linked files, and deletes managed skills', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dagent-skills-'));
    temporaryDirectories.push(root);
    const store = new SkillStore({ managedRoot: join(root, 'managed') });
    const installed = await store.installMarkdown(
      '---\nname: concise\ndescription: Be concise.\ncategory: writing\n---\n\nKeep answers short.',
    );
    await mkdir(join(installed.skill.directory, 'references'));
    await writeFile(
      join(installed.skill.directory, 'references', 'guide.md'),
      'One clear sentence.',
      'utf8',
    );

    expect((await store.list()).map((skill) => skill.qualifiedName)).toEqual(['writing/concise']);
    expect((await store.view('writing/concise', 'references/guide.md')).content).toBe(
      'One clear sentence.',
    );
    await expect(store.view('writing/concise', '../SKILL.md')).rejects.toThrow(
      /safe relative path/u,
    );
    await store.delete('writing/concise');
    expect(await store.list()).toEqual([]);
  });

  it('installs a ZIP package with linked files under one package root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dagent-skills-archive-'));
    temporaryDirectories.push(root);
    const store = new SkillStore({ managedRoot: join(root, 'managed') });
    const archive = storedZip({
      'bundle/SKILL.md':
        '---\nname: summarize\ndescription: Summarize.\ncategory: writing\n---\n\nUse the helpers.',
      'bundle/references/style.md': 'Keep it short.\n',
      'bundle/scripts/run.js': "console.log('ok');\n",
    });

    const installed = await store.installArchive(archive);

    expect(installed.skill.qualifiedName).toBe('writing/summarize');
    expect(installed.linkedFiles).toEqual({
      assets: [],
      references: ['references/style.md'],
      scripts: ['scripts/run.js'],
      templates: [],
    });
    expect((await store.view('writing/summarize', 'scripts/run.js')).content).toBe(
      "console.log('ok');\n",
    );
  });

  it('rejects ZIP path traversal and does not write escaped files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dagent-skills-unsafe-'));
    temporaryDirectories.push(root);
    const store = new SkillStore({ managedRoot: join(root, 'managed') });
    const archive = storedZip({
      'bundle/SKILL.md': '---\nname: unsafe\n---\nBody.',
      '../escaped.txt': 'escaped',
    });

    await expect(store.installArchive(archive)).rejects.toThrow('safe relative path');
    expect(await store.list()).toEqual([]);
  });
});

function storedZip(files: Readonly<Record<string, string>>): Uint8Array {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const [path, text] of Object.entries(files)) {
    const name = Buffer.from(path, 'utf8');
    const content = Buffer.from(text, 'utf8');
    const checksum = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + content.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

let testCrcTable: Uint32Array | undefined;

function crc32(bytes: Uint8Array): number {
  testCrcTable ??= createCrcTable();
  let value = 0xffffffff;
  for (const byte of bytes) value = (testCrcTable[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function createCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}
