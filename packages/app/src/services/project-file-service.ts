import { lstat, readdir, readFile, rename, rm, rmdir, stat } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';

import { Workspace } from 'dagent-ai';

import type { AppRepository, Project } from '../database/repositories.js';
import { mediaTypeForPath } from './file-metadata.js';

const DEFAULT_PREVIEW_LIMIT = 1024 * 1024;
const DEFAULT_WRITE_LIMIT = 25 * 1024 * 1024;

export type ProjectFileEntry = {
  readonly path: string;
  readonly name: string;
  readonly type: 'file' | 'directory';
  readonly size: number;
  readonly modifiedAt: string;
};

export type ProjectFileView =
  | {
      readonly path: string;
      readonly type: 'directory';
      readonly entries: readonly ProjectFileEntry[];
    }
  | (ProjectFileEntry & {
      readonly type: 'file';
      readonly mediaType: string;
      readonly content?: string;
      readonly previewOmitted?: 'binary' | 'too-large';
    });

export type ProjectFileDownload = {
  readonly path: string;
  readonly name: string;
  readonly mediaType: string;
  readonly content: Uint8Array;
};

export class ProjectFileError extends Error {
  public constructor(
    public readonly code:
      | 'FILE_ALREADY_EXISTS'
      | 'FILE_NOT_FOUND'
      | 'FILE_TOO_LARGE'
      | 'INVALID_FILE_OPERATION'
      | 'PROJECT_NOT_FOUND'
      | 'UNSUPPORTED_FILE',
    message: string,
    public readonly statusCode: 400 | 404 | 409 | 413 | 415,
  ) {
    super(message);
    this.name = 'ProjectFileError';
  }
}

export class ProjectFileService {
  public constructor(
    private readonly repository: AppRepository,
    private readonly previewLimit = DEFAULT_PREVIEW_LIMIT,
    private readonly writeLimit = DEFAULT_WRITE_LIMIT,
  ) {}

  public async inspect(projectId: string, candidate = '.'): Promise<ProjectFileView> {
    const workspace = await this.#workspace(projectId);
    const target = await this.#existingPath(workspace, candidate);
    const info = await stat(target);
    const path = displayPath(workspace, target);
    if (info.isDirectory()) {
      const entries = await readdir(target, { withFileTypes: true });
      const visible = await Promise.all(
        entries
          .filter((entry) => !entry.isSymbolicLink())
          .map(async (entry): Promise<ProjectFileEntry | undefined> => {
            if (!entry.isDirectory() && !entry.isFile()) return undefined;
            const entryTarget = workspace.resolve(
              relative(workspace.root, join(target, entry.name)),
            );
            const entryInfo = await stat(entryTarget);
            return {
              path: displayPath(workspace, entryTarget),
              name: entry.name,
              type: entry.isDirectory() ? 'directory' : 'file',
              size: entryInfo.size,
              modifiedAt: entryInfo.mtime.toISOString(),
            };
          }),
      );
      return {
        path,
        type: 'directory',
        entries: visible
          .filter((entry): entry is ProjectFileEntry => entry !== undefined)
          .sort(compareEntries),
      };
    }
    this.#assertRegularFile(candidate, info.isFile());
    const entry = fileEntry(workspace, target, info.size, info.mtime);
    const mediaType = mediaTypeForPath(target);
    if (info.size > this.previewLimit) {
      return { ...entry, mediaType, previewOmitted: 'too-large' };
    }
    const bytes = await readFile(target);
    try {
      return {
        ...entry,
        mediaType,
        content: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      };
    } catch {
      return { ...entry, mediaType, previewOmitted: 'binary' };
    }
  }

  public async createDirectory(projectId: string, candidate: string): Promise<ProjectFileEntry> {
    const workspace = await this.#workspace(projectId);
    const target = await workspace.ensureDirectory(candidate);
    const info = await stat(target);
    return {
      path: displayPath(workspace, target),
      name: basename(target),
      type: 'directory',
      size: info.size,
      modifiedAt: info.mtime.toISOString(),
    };
  }

  public async write(
    projectId: string,
    candidate: string,
    content: string | Uint8Array,
    options: { readonly overwrite?: boolean } = {},
  ): Promise<ProjectFileEntry> {
    const workspace = await this.#workspace(projectId);
    const size =
      typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : content.byteLength;
    if (size > this.writeLimit) {
      throw new ProjectFileError(
        'FILE_TOO_LARGE',
        `File exceeds the ${this.writeLimit}-byte upload limit.`,
        413,
      );
    }
    try {
      const target = await workspace.writeFile(candidate, content, options);
      const info = await stat(target);
      return fileEntry(workspace, target, info.size, info.mtime);
    } catch (error) {
      if (fileSystemCode(error) === 'EEXIST') {
        throw new ProjectFileError(
          'FILE_ALREADY_EXISTS',
          `Path '${candidate}' already exists.`,
          409,
        );
      }
      throw error;
    }
  }

  public async move(
    projectId: string,
    source: string,
    destination: string,
    options: { readonly overwrite?: boolean } = {},
  ): Promise<ProjectFileEntry> {
    const workspace = await this.#workspace(projectId);
    const sourceTarget = await this.#existingPath(workspace, source);
    this.#assertMutableTarget(workspace, sourceTarget);
    const sourceInfo = await lstat(sourceTarget);
    this.#assertNotSymbolicLink(source, sourceInfo.isSymbolicLink());
    const requestedDestination = workspace.resolve(destination);
    const destinationWithinSource = relative(sourceTarget, requestedDestination);
    if (
      requestedDestination === sourceTarget ||
      (sourceInfo.isDirectory() &&
        destinationWithinSource !== '..' &&
        !destinationWithinSource.startsWith('../'))
    ) {
      throw new ProjectFileError(
        'INVALID_FILE_OPERATION',
        'A path cannot be moved onto itself or into one of its descendants.',
        400,
      );
    }
    const destinationTarget = await workspace.ensureParent(destination);
    const destinationInfo = await lstat(destinationTarget).catch((error: unknown) => {
      if (fileSystemCode(error) === 'ENOENT') return undefined;
      throw error;
    });
    if (destinationInfo !== undefined && options.overwrite !== true) {
      throw new ProjectFileError(
        'FILE_ALREADY_EXISTS',
        `Path '${destination}' already exists.`,
        409,
      );
    }
    const sourceWithinDestination = relative(destinationTarget, sourceTarget);
    if (
      destinationInfo !== undefined &&
      options.overwrite === true &&
      sourceWithinDestination !== '..' &&
      !sourceWithinDestination.startsWith('../')
    ) {
      throw new ProjectFileError(
        'INVALID_FILE_OPERATION',
        'The destination contains the source and cannot be overwritten.',
        400,
      );
    }
    if (destinationInfo !== undefined) {
      await rm(destinationTarget, { force: false, recursive: true });
    }
    await rename(sourceTarget, destinationTarget);
    const info = await stat(destinationTarget);
    return info.isDirectory()
      ? {
          path: displayPath(workspace, destinationTarget),
          name: basename(destinationTarget),
          type: 'directory',
          size: info.size,
          modifiedAt: info.mtime.toISOString(),
        }
      : fileEntry(workspace, destinationTarget, info.size, info.mtime);
  }

  public async delete(
    projectId: string,
    candidate: string,
    options: { readonly recursive?: boolean } = {},
  ): Promise<void> {
    const workspace = await this.#workspace(projectId);
    const target = await this.#existingPath(workspace, candidate);
    this.#assertMutableTarget(workspace, target);
    const info = await lstat(target);
    this.#assertNotSymbolicLink(candidate, info.isSymbolicLink());
    if (info.isDirectory() && options.recursive !== true) {
      await rmdir(target);
      return;
    }
    await rm(target, { force: false, recursive: info.isDirectory() });
  }

  public async download(projectId: string, candidate: string): Promise<ProjectFileDownload> {
    const workspace = await this.#workspace(projectId);
    const target = await this.#existingPath(workspace, candidate);
    const info = await stat(target);
    this.#assertRegularFile(candidate, info.isFile());
    return {
      path: displayPath(workspace, target),
      name: basename(target),
      mediaType: mediaTypeForPath(target),
      content: await readFile(target),
    };
  }

  async #workspace(projectId: string): Promise<Workspace> {
    const project = await this.repository.getProject(projectId);
    if (project === undefined) {
      throw new ProjectFileError('PROJECT_NOT_FOUND', 'Project not found.', 404);
    }
    return openProjectWorkspace(project);
  }

  async #existingPath(workspace: Workspace, candidate: string): Promise<string> {
    try {
      return await workspace.resolveExisting(candidate || '.');
    } catch (error) {
      if (fileSystemCode(error) === 'ENOENT') {
        throw new ProjectFileError('FILE_NOT_FOUND', `Path '${candidate}' was not found.`, 404);
      }
      throw error;
    }
  }

  #assertMutableTarget(workspace: Workspace, target: string): void {
    if (target === workspace.root) {
      throw new ProjectFileError(
        'UNSUPPORTED_FILE',
        'The project root cannot be moved or deleted.',
        415,
      );
    }
  }

  #assertNotSymbolicLink(candidate: string, symbolicLink: boolean): void {
    if (symbolicLink) {
      throw new ProjectFileError(
        'UNSUPPORTED_FILE',
        `Path '${candidate}' is a symbolic link.`,
        415,
      );
    }
  }

  #assertRegularFile(candidate: string, regularFile: boolean): void {
    if (!regularFile) {
      throw new ProjectFileError(
        'UNSUPPORTED_FILE',
        `Path '${candidate}' is not a regular file.`,
        415,
      );
    }
  }
}

async function openProjectWorkspace(project: Project): Promise<Workspace> {
  return Workspace.open(project.rootPath);
}

function displayPath(workspace: Workspace, target: string): string {
  const path = relative(workspace.root, target);
  return path === '' ? '.' : path.split('\\').join('/');
}

function fileEntry(
  workspace: Workspace,
  target: string,
  size: number,
  modifiedAt: Date,
): ProjectFileEntry & { readonly type: 'file' } {
  return {
    path: displayPath(workspace, target),
    name: basename(target),
    type: 'file',
    size,
    modifiedAt: modifiedAt.toISOString(),
  };
}

function compareEntries(left: ProjectFileEntry, right: ProjectFileEntry): number {
  if (left.type !== right.type) return left.type === 'directory' ? -1 : 1;
  return left.name.localeCompare(right.name);
}

function fileSystemCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}
