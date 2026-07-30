import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { conversationStateSchema, userMessageSchema } from '../contracts/index.js';
import { ConversationResourceStore, materializeInputUploads } from './conversation-resources.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('ConversationResourceStore', () => {
  it('retains uploaded files by digest and rebases them into a later run workspace', async () => {
    const root = await temporaryDirectory();
    const firstWorkspace = join(root, 'runs', 'first');
    const secondWorkspace = join(root, 'runs', 'second');
    const [attachment] = await materializeInputUploads(
      [{ filename: 'notes/spec.md', content: Buffer.from('# durable input') }],
      firstWorkspace,
    );
    const conversation = conversationStateSchema.parse({
      schemaVersion: 3,
      id: 'conversation-durable',
      items: [
        userMessageSchema.parse({
          type: 'user',
          content: 'Use the specification.',
          attachments: [attachment],
        }),
      ],
    });
    const resources = new ConversationResourceStore(root, '.runtime');

    await resources.persist(conversation, firstWorkspace);
    await rm(firstWorkspace, { recursive: true, force: true });
    const restored = await resources.materialize(conversation, secondWorkspace);

    const restoredUser = restored.items[0];
    expect(restoredUser?.type).toBe('user');
    if (restoredUser?.type !== 'user') return;
    const restoredAttachment = restoredUser.attachments[0];
    expect(restoredAttachment).toBeDefined();
    if (restoredAttachment === undefined) return;
    expect(restoredAttachment.path).toBe(`.runtime/history/${restoredAttachment.sha256}.md`);
    await expect(readFile(join(secondWorkspace, restoredAttachment.path), 'utf8')).resolves.toBe(
      '# durable input',
    );
  });

  it('reuses a verified resource already reachable in the continuation workspace', async () => {
    const root = await temporaryDirectory();
    const workspace = join(root, 'run');
    const [attachment] = await materializeInputUploads(
      [{ filename: 'existing.txt', content: Buffer.from('already here') }],
      workspace,
    );
    const conversation = conversationStateSchema.parse({
      schemaVersion: 3,
      id: 'conversation-existing',
      revision: 7,
      items: [
        userMessageSchema.parse({
          type: 'user',
          content: 'Continue.',
          attachments: [attachment],
        }),
      ],
    });
    const backingRoot = join(root, 'backing');
    const resources = new ConversationResourceStore(backingRoot, '.runtime');

    const restored = await resources.materialize(conversation, workspace);

    expect(restored).toBe(conversation);
    expect(restored.revision).toBe(7);
    await expect(access(join(backingRoot, '.runtime'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['../escape.txt', 'safe/../../escape.txt', 'C:/escape.txt'])(
    'rejects unsafe upload paths: %s',
    async (filename) => {
      const workspace = await temporaryDirectory();

      await expect(
        materializeInputUploads([{ filename, content: Buffer.from('untrusted') }], workspace),
      ).rejects.toMatchObject({ code: 'WORKSPACE_VIOLATION' });
    },
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dagent-conversation-v3-'));
  temporaryDirectories.push(directory);
  return directory;
}
