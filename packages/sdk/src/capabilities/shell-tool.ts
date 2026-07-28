import { spawn } from 'node:child_process';

import { z } from 'zod';

import { DagentError } from '../errors.js';
import type { CommandExecutor } from '../sandbox/index.js';
import { tool, type CapabilityBinding } from './tool.js';
import { Workspace } from './workspace.js';

const dangerousCommandPatterns = [
  /(?:^|\s)rm\s+(?:-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r)\s+(?:\/|~|\$HOME)(?:\s|$)/i,
  /(?:^|\s)(?:mkfs|shutdown|reboot|poweroff)(?:\s|$)/i,
  /:\(\)\s*\{\s*:\|:&\s*\};:/,
];

export function createShellTool(
  options: { readonly executor?: CommandExecutor } = {},
): CapabilityBinding {
  return tool({
    id: 'tool.shell',
    name: 'shell',
    description: 'Run a shell command inside the run workspace.',
    input: z
      .object({
        command: z.string().min(1),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(10 * 60 * 1000)
          .default(60_000),
      })
      .strict(),
    output: z
      .object({
        exitCode: z.number().int(),
        stdout: z.string(),
        stderr: z.string(),
      })
      .strict(),
    risk: 'high',
    boundary: { workspaceRead: true, workspaceWrite: true, process: true },
    execute: async ({ command, timeoutMs }, context) => {
      if (dangerousCommandPatterns.some((pattern) => pattern.test(command))) {
        throw new DagentError('WORKSPACE_VIOLATION', 'The command is blocked by shell policy.');
      }
      const workspace = await Workspace.open(context.workspacePath);
      if (options.executor !== undefined) {
        return options.executor.execute(command, {
          workspacePath: workspace.root,
          timeoutMs,
          signal: context.signal,
        });
      }
      return runShell(command, workspace.root, timeoutMs, context.signal);
    },
  });
}

async function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, {
      cwd,
      shell: process.env['SHELL'] ?? '/bin/sh',
      signal,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}
