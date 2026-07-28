import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DagentError } from '../errors.js';
import { discoverCapabilityModuleExports, loadCapabilityModule } from './capability-loader.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('capability module loading', () => {
  it('loads declarative modules without runtime package imports', async () => {
    const root = await temporaryDirectory();
    const path = join(root, 'echo.mjs');
    await writeFile(
      path,
      [
        'export const tools = {',
        '  schemaVersion: 1,',
        '  capabilities: [{',
        "    id: 'tool.echo',",
        "    name: 'Echo',",
        "    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },",
        "    outputSchema: { type: 'string' },",
        '    execute({ text }) { return text; },',
        '  }],',
        '};',
      ].join('\n'),
    );

    const discovered = await discoverCapabilityModuleExports(path, root);
    const [binding] = await loadCapabilityModule({
      path,
      exports: ['tools'],
      root,
    });

    expect(discovered).toEqual([{ name: 'tools', capabilityIds: ['tool.echo'] }]);
    expect(binding?.definition).toMatchObject({
      id: 'tool.echo',
      source: `module:${path}#tools`,
    });
    expect(binding?.input.parse({ text: 'hello' })).toEqual({ text: 'hello' });
    await expect(
      Promise.resolve(
        binding?.execute(
          { text: 'hello' },
          {
            runId: 'run_module' as never,
            workspacePath: root,
            signal: new AbortController().signal,
            metadata: {},
          },
        ),
      ),
    ).resolves.toBe('hello');
  });

  it('rejects duplicate capability ids across selected exports', async () => {
    const root = await temporaryDirectory();
    const path = join(root, 'duplicate.mjs');
    const definition = [
      'schemaVersion: 1,',
      'capabilities: [{',
      "id: 'tool.echo',",
      "inputSchema: { type: 'object' },",
      'execute(input) { return input; },',
      '}],',
    ].join('\n');
    await writeFile(
      path,
      `export const first = { ${definition} };\nexport const second = { ${definition} };\n`,
    );

    await expect(
      loadCapabilityModule({ path, exports: ['first', 'second'], root }),
    ).rejects.toThrow("Capability 'tool.echo' is exported more than once");
  });

  it('enforces explicit unique export selections', async () => {
    const root = await temporaryDirectory();
    const path = join(root, 'empty.mjs');
    await writeFile(path, 'export const nothing = 1;\n');

    await expect(loadCapabilityModule({ path, exports: [], root })).rejects.toBeInstanceOf(
      DagentError,
    );
    await expect(
      loadCapabilityModule({ path, exports: ['nothing', 'nothing'], root }),
    ).rejects.toThrow('unique, explicit export names');
  });

  it('rejects modules that escape their trusted root through a symlink', async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const outsideModule = join(outside, 'outside.mjs');
    const link = join(root, 'linked.mjs');
    await writeFile(outsideModule, 'export const value = 1;\n');
    await symlink(outsideModule, link);

    await expect(discoverCapabilityModuleExports(link, root)).rejects.toMatchObject({
      code: 'WORKSPACE_VIOLATION',
    });
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dagent-module-'));
  temporaryDirectories.push(directory);
  return directory;
}
