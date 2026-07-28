import { lstat, readdir, readFile } from 'node:fs/promises';

import { z } from 'zod';

import { tool, type CapabilityBinding } from './tool.js';
import { Workspace } from './workspace.js';

export function createFileTools(): readonly CapabilityBinding[] {
  const read = tool({
    id: 'tool.read_file',
    name: 'read_file',
    description: 'Read a UTF-8 text file within the run workspace.',
    input: z.object({ path: z.string().min(1) }).strict(),
    output: z.object({ path: z.string(), content: z.string() }).strict(),
    boundary: { workspaceRead: true },
    execute: async ({ path }, context) => {
      const workspace = await Workspace.open(context.workspacePath);
      return {
        path,
        content: await readFile(await workspace.resolveExisting(path), 'utf8'),
      };
    },
  });

  const write = tool({
    id: 'tool.write_file',
    name: 'write_file',
    description: 'Write a UTF-8 text file within the run workspace.',
    input: z
      .object({
        path: z.string().min(1),
        content: z.string(),
        overwrite: z.boolean().default(true),
      })
      .strict(),
    output: z.object({ path: z.string(), bytes: z.number().int().nonnegative() }).strict(),
    risk: 'medium',
    boundary: { workspaceWrite: true },
    execute: async ({ path, content, overwrite }, context) => {
      const workspace = await Workspace.open(context.workspacePath);
      await workspace.writeFile(path, content, { overwrite });
      return { path, bytes: Buffer.byteLength(content) };
    },
  });

  const list = tool({
    id: 'tool.list_files',
    name: 'list_files',
    description: 'List files in a workspace directory.',
    input: z.object({ path: z.string().default('.') }).strict(),
    output: z
      .array(
        z
          .object({
            name: z.string(),
            path: z.string(),
            kind: z.enum(['file', 'directory', 'other']),
            size: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .readonly(),
    boundary: { workspaceRead: true },
    execute: async ({ path }, context) => {
      const workspace = await Workspace.open(context.workspacePath);
      const directory = await workspace.resolveExisting(path);
      const entries = await readdir(directory, { withFileTypes: true });
      return Promise.all(
        entries
          .sort((left, right) => left.name.localeCompare(right.name))
          .map(async (entry) => {
            const childPath = path === '.' ? entry.name : `${path}/${entry.name}`;
            const info = await lstat(workspace.resolve(childPath));
            return {
              name: entry.name,
              path: childPath,
              kind: entry.isSymbolicLink()
                ? 'other'
                : entry.isFile()
                  ? 'file'
                  : entry.isDirectory()
                    ? 'directory'
                    : 'other',
              size: info.size,
            } as const;
          }),
      );
    },
  });

  return [read, write, list];
}
