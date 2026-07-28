import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MockProvider } from './testing/mock-provider.js';
import { createRunnerFromConfigFile, runnerConfigSchema } from './config.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('runner configuration', () => {
  it('applies complete defaults and rejects unknown keys', () => {
    expect(runnerConfigSchema.parse({})).toMatchObject({
      workspace: '.dagent-ts',
      builtins: ['files', 'shell', 'memory'],
      sandbox: { enabled: false },
      validation: { enabled: false, maxRetries: 1 },
      mcpServers: [],
      modules: [],
      agents: [],
    });
    expect(() => runnerConfigSchema.parse({ unknown: true })).toThrow();
    expect(() =>
      runnerConfigSchema.parse({
        contextWindowTokens: 4096,
        outputReserveTokens: 4096,
      }),
    ).toThrow(/outputReserveTokens/u);
  });

  it('resolves workspace, skills, and agent configuration relative to the file', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'dagent.yaml');
    await writeFile(
      path,
      [
        'workspace: ./runtime',
        'builtins: [memory]',
        'skills:',
        '  roots: [./shared-skills]',
        '  managedRoot: ./managed-skills',
        'agents:',
        '  - kind: tool-agent',
        '    id: configured_agent',
        '    name: Configured Agent',
        '    systemPrompt: Help.',
        '    scope:',
        '      capabilities: [tool.memory_get]',
        '    reviewLevel: never',
      ].join('\n'),
    );

    const runner = await createRunnerFromConfigFile(path, {
      provider: new MockProvider([]),
    });

    expect(runner.workspacePath).toBe(resolve(directory, 'runtime'));
    expect(runner.skills.roots).toEqual([
      resolve(directory, 'shared-skills'),
      resolve(directory, 'managed-skills'),
    ]);
    expect(runner.catalog.get('tool.memory_get')).toBeDefined();
    expect(runner.catalog.get('tool.read_file')).toBeUndefined();
    expect(runner.agent('configured_agent')).toMatchObject({
      kind: 'tool-agent',
      reviewLevel: 'never',
    });
    await runner.close();
  });

  it('loads a managed validation profile without exposing file-system concerns to Runner', async () => {
    const directory = await temporaryDirectory();
    await mkdir(join(directory, 'profiles'));
    await writeFile(
      join(directory, 'profiles', 'reviewer.md'),
      '# Reviewer\n\nCheck project-specific constraints.',
    );
    const path = join(directory, 'dagent.yaml');
    await writeFile(
      path,
      [
        'builtins: []',
        'profiles:',
        '  directory: ./profiles',
        'validation:',
        '  enabled: true',
        '  maxRetries: 2',
        '  profile: reviewer',
      ].join('\n'),
    );

    const runner = await createRunnerFromConfigFile(path, {
      provider: new MockProvider([]),
    });

    expect(runner.validationPolicy).toMatchObject({
      enabled: true,
      maxRetries: 2,
      profile: {
        name: 'reviewer',
        content: expect.stringContaining('project-specific constraints'),
      },
    });
    await runner.close();
  });

  it('fails clearly when an enabled validation profile does not exist', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'dagent.yaml');
    await writeFile(
      path,
      ['builtins: []', 'validation:', '  enabled: true', '  profile: missing_profile'].join('\n'),
    );

    await expect(
      createRunnerFromConfigFile(path, { provider: new MockProvider([]) }),
    ).rejects.toThrow(/does not exist/u);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dagent-config-'));
  temporaryDirectories.push(directory);
  return directory;
}
