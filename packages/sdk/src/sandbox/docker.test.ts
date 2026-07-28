import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DockerCommandRunner } from './docker.js';
import { DockerSandbox, dockerSandboxConfigSchema } from './docker.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('DockerSandbox', () => {
  it('applies hardened defaults and rejects unknown configuration', () => {
    expect(dockerSandboxConfigSchema.parse({})).toMatchObject({
      image: 'node:24-alpine',
      network: false,
      memory: '512m',
      cpus: 1,
      pidsLimit: 256,
      environment: {},
      skillDirectories: [],
      timeoutMs: 60_000,
    });
    expect(() => dockerSandboxConfigSchema.parse({ privileged: true })).toThrow();
  });

  it('builds a read-only, capability-dropped container command with bounded resources', async () => {
    const workspace = await temporaryDirectory('workspace');
    const skills = await temporaryDirectory('skills');
    const runner = vi.fn<DockerCommandRunner>().mockResolvedValue({
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
    });
    const sandbox = new DockerSandbox(
      {
        image: 'node:24',
        network: false,
        memory: '256m',
        cpus: 0.5,
        pidsLimit: 64,
        user: '123:456',
        environment: { MODE: 'test' },
        skillDirectories: [skills],
        timeoutMs: 5000,
      },
      runner,
    );
    const controller = new AbortController();

    await sandbox.execute('node task.js', {
      workspacePath: workspace,
      timeoutMs: 10_000,
      signal: controller.signal,
    });

    const resolvedWorkspace = await realpath(workspace);
    const resolvedSkills = await realpath(skills);
    expect(runner).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining([
        'run',
        '--rm',
        '--read-only',
        '--network',
        'none',
        '--memory',
        '256m',
        '--pids-limit',
        '64',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--user',
        '123:456',
        '--env',
        'MODE=test',
        `${resolvedWorkspace}:${resolvedWorkspace}:rw`,
        `${resolvedSkills}:${resolvedSkills}:ro`,
        'node:24',
        '/bin/sh',
        '-lc',
        'node task.js',
      ]),
      { signal: controller.signal, timeoutMs: 5000 },
    );
  });

  it('reports daemon availability without throwing status errors', async () => {
    const availableRunner = vi.fn<DockerCommandRunner>().mockResolvedValue({
      exitCode: 0,
      stdout: '"27.0"',
      stderr: '',
    });
    const unavailableRunner = vi.fn<DockerCommandRunner>().mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'daemon offline',
    });

    await expect(new DockerSandbox({}, availableRunner).status()).resolves.toMatchObject({
      backend: 'docker',
      available: true,
      network: false,
    });
    await expect(new DockerSandbox({}, unavailableRunner).status()).resolves.toMatchObject({
      available: false,
      error: 'daemon offline',
    });
  });

  it('wraps process-launch failures in a stable sandbox error', async () => {
    const workspace = await temporaryDirectory('workspace');
    const sandbox = new DockerSandbox({}, async () => {
      throw new Error('docker missing');
    });

    await expect(
      sandbox.execute('true', {
        workspacePath: workspace,
        timeoutMs: 1000,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      code: 'SANDBOX_UNAVAILABLE',
      message: expect.stringContaining('docker missing'),
    });
  });
});

async function temporaryDirectory(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `dagent-docker-${name}-`));
  temporaryDirectories.push(root);
  await mkdir(root, { recursive: true });
  return root;
}
