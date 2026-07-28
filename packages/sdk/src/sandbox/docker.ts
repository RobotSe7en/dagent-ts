import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

import { z } from 'zod';

import { DagentError, errorMessage } from '../errors.js';

export const dockerSandboxConfigSchema = z
  .object({
    image: z.string().min(1).default('node:24-alpine'),
    network: z.boolean().default(false),
    memory: z.string().min(1).default('512m'),
    cpus: z.number().positive().default(1),
    pidsLimit: z.number().int().positive().default(256),
    user: z.string().min(1).optional(),
    environment: z.record(z.string(), z.string()).default({}),
    skillDirectories: z.array(z.string()).default([]),
    timeoutMs: z.number().int().positive().default(60_000),
  })
  .strict();

export type DockerSandboxConfig = z.infer<typeof dockerSandboxConfigSchema>;

export type CommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export interface CommandExecutor {
  execute(
    command: string,
    options: {
      readonly workspacePath: string;
      readonly timeoutMs: number;
      readonly signal: AbortSignal;
    },
  ): Promise<CommandResult>;
}

export type SandboxStatus = {
  readonly backend: 'docker';
  readonly available: boolean;
  readonly image: string;
  readonly network: boolean;
  readonly error?: string;
};

export type DockerCommandRunner = (
  executable: string,
  args: readonly string[],
  options: {
    readonly signal?: AbortSignal;
    readonly timeoutMs: number;
  },
) => Promise<CommandResult>;

export class DockerSandbox implements CommandExecutor {
  readonly #config: DockerSandboxConfig;
  readonly #commandRunner: DockerCommandRunner;

  public constructor(
    config: Partial<DockerSandboxConfig> = {},
    commandRunner: DockerCommandRunner = spawnCommand,
  ) {
    this.#config = dockerSandboxConfigSchema.parse(config);
    this.#commandRunner = commandRunner;
  }

  public async status(): Promise<SandboxStatus> {
    try {
      const result = await this.#commandRunner(
        'docker',
        ['info', '--format', '{{json .ServerVersion}}'],
        { timeoutMs: 5000 },
      );
      if (result.exitCode !== 0) {
        return {
          backend: 'docker',
          available: false,
          image: this.#config.image,
          network: this.#config.network,
          error: result.stderr.trim() || 'Docker daemon is unavailable.',
        };
      }
      return {
        backend: 'docker',
        available: true,
        image: this.#config.image,
        network: this.#config.network,
      };
    } catch (error) {
      return {
        backend: 'docker',
        available: false,
        image: this.#config.image,
        network: this.#config.network,
        error: errorMessage(error),
      };
    }
  }

  public async execute(
    command: string,
    options: {
      readonly workspacePath: string;
      readonly timeoutMs: number;
      readonly signal: AbortSignal;
    },
  ): Promise<CommandResult> {
    const workspace = await realpath(resolve(options.workspacePath));
    const timeoutMs = Math.min(options.timeoutMs, this.#config.timeoutMs);
    const args = [
      'run',
      '--rm',
      '--read-only',
      '--workdir',
      workspace,
      '--volume',
      `${workspace}:${workspace}:rw`,
      '--network',
      this.#config.network ? 'bridge' : 'none',
      '--memory',
      this.#config.memory,
      '--cpus',
      String(this.#config.cpus),
      '--pids-limit',
      String(this.#config.pidsLimit),
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--tmpfs',
      '/tmp:rw,nosuid,nodev,size=64m',
      '--user',
      this.#config.user ?? defaultUser(),
    ];
    for (const [name, value] of Object.entries(this.#config.environment)) {
      args.push('--env', `${name}=${value}`);
    }
    for (const directoryValue of this.#config.skillDirectories) {
      const directory = await realpath(resolve(directoryValue));
      if (directory !== workspace && !directory.startsWith(`${workspace}/`)) {
        args.push('--volume', `${directory}:${directory}:ro`);
      }
    }
    args.push(this.#config.image, '/bin/sh', '-lc', command);
    try {
      return await this.#commandRunner('docker', args, {
        signal: options.signal,
        timeoutMs,
      });
    } catch (error) {
      throw new DagentError(
        'SANDBOX_UNAVAILABLE',
        `Docker sandbox execution failed: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }
}

function defaultUser(): string {
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  return uid === 0 ? '1000:1000' : `${uid}:${gid}`;
}

function spawnCommand(
  executable: string,
  args: readonly string[],
  options: {
    readonly signal?: AbortSignal;
    readonly timeoutMs: number;
  },
): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Command exceeded ${options.timeoutMs} ms.`));
        return;
      }
      resolvePromise({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}
