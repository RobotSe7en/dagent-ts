import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runIdSchema } from '../contracts/index.js';
import type { CommandExecutor } from '../sandbox/index.js';
import { CapabilityCatalog } from './catalog.js';
import { createFileTools } from './file-tools.js';
import { createMemoryTools, MemoryStore } from './memory.js';
import { createShellTool } from './shell-tool.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('built-in capabilities', () => {
  it('writes, reads, and deterministically lists workspace files', async () => {
    const workspacePath = await temporaryDirectory();
    const catalog = new CapabilityCatalog(createFileTools());

    const write = await invoke(catalog, 'tool.write_file', workspacePath, {
      path: 'notes/你好.txt',
      content: 'hello',
    });
    const read = await invoke(catalog, 'tool.read_file', workspacePath, {
      path: 'notes/你好.txt',
    });
    const list = await invoke(catalog, 'tool.list_files', workspacePath, {
      path: 'notes',
    });

    expect(write.result).toMatchObject({
      status: 'completed',
      output: { path: 'notes/你好.txt', bytes: 5 },
    });
    expect(read.result.output).toEqual({
      path: 'notes/你好.txt',
      content: 'hello',
    });
    expect(list.result.output).toEqual([
      expect.objectContaining({ name: '你好.txt', kind: 'file' }),
    ]);
  });

  it('contains file writes within the workspace and honors overwrite policy', async () => {
    const workspacePath = await temporaryDirectory();
    const catalog = new CapabilityCatalog(createFileTools());
    await invoke(catalog, 'tool.write_file', workspacePath, {
      path: 'existing.txt',
      content: 'first',
    });

    const overwrite = await invoke(catalog, 'tool.write_file', workspacePath, {
      path: 'existing.txt',
      content: 'second',
      overwrite: false,
    });
    const traversal = await invoke(catalog, 'tool.write_file', workspacePath, {
      path: '../outside.txt',
      content: 'blocked',
    });

    expect(overwrite.result).toMatchObject({ status: 'failed' });
    expect(traversal.result).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/workspace/u),
    });
  });

  it('shares explicit memory stores without leaking across stores', async () => {
    const firstStore = new MemoryStore();
    const first = new CapabilityCatalog(createMemoryTools(firstStore));
    const second = new CapabilityCatalog(createMemoryTools());
    const workspacePath = await temporaryDirectory();

    await invoke(first, 'tool.memory_set', workspacePath, {
      key: 'preferences',
      value: { language: 'ts' },
    });
    const found = await invoke(first, 'tool.memory_get', workspacePath, {
      key: 'preferences',
    });
    const absent = await invoke(second, 'tool.memory_get', workspacePath, {
      key: 'preferences',
    });

    expect(firstStore.entries()).toEqual([['preferences', { language: 'ts' }]]);
    expect(found.result.output).toEqual({
      found: true,
      value: { language: 'ts' },
    });
    expect(absent.result.output).toEqual({ found: false });
  });

  it('delegates shell execution through the configured sandbox executor', async () => {
    const execute = vi.fn<CommandExecutor['execute']>().mockResolvedValue({
      exitCode: 0,
      stdout: 'ok\n',
      stderr: '',
    });
    const catalog = new CapabilityCatalog([createShellTool({ executor: { execute } })]);
    const workspacePath = await temporaryDirectory();

    const outcome = await invoke(catalog, 'tool.shell', workspacePath, {
      command: 'pwd',
      timeoutMs: 1234,
    });

    expect(outcome.result.output).toEqual({
      exitCode: 0,
      stdout: 'ok\n',
      stderr: '',
    });
    expect(execute).toHaveBeenCalledWith('pwd', {
      workspacePath,
      timeoutMs: 1234,
      signal: expect.any(AbortSignal),
    });
  });

  it.each(['rm -rf /', 'rm -fr $HOME', 'mkfs /dev/sda', 'shutdown now', ':(){ :|:& };:'])(
    'blocks dangerous shell command %s before execution',
    async (command) => {
      const execute = vi.fn<CommandExecutor['execute']>();
      const catalog = new CapabilityCatalog([createShellTool({ executor: { execute } })]);
      const outcome = await invoke(catalog, 'tool.shell', await temporaryDirectory(), { command });

      expect(outcome.result).toMatchObject({
        status: 'failed',
        error: expect.stringMatching(/blocked by shell policy/u),
      });
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('rejects invalid capability arguments before invoking the implementation', async () => {
    const catalog = new CapabilityCatalog(createMemoryTools());
    await expect(
      invoke(catalog, 'tool.memory_get', await temporaryDirectory(), { key: '' }),
    ).rejects.toThrow();
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dagent-builtins-'));
  temporaryDirectories.push(directory);
  return directory;
}

function invoke(
  catalog: CapabilityCatalog,
  capabilityId: string,
  workspacePath: string,
  arguments_: Readonly<Record<string, unknown>>,
) {
  return catalog.invoke(capabilityId, arguments_, {
    runId: runIdSchema.parse('test-run'),
    workspacePath,
    signal: new AbortController().signal,
    metadata: {},
  });
}
