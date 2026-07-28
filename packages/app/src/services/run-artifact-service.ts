import { open, readdir, readFile, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { basename, join, posix, relative } from 'node:path';

import { Workspace } from 'dagent-ai';
import type { ArtifactStates, RunId } from 'dagent-ai';

import type { AppRepository, StoredRun } from '../database/repositories.js';
import { mediaTypeForPath, previewKindForPath, type FilePreviewKind } from './file-metadata.js';

const DEFAULT_MAX_FILES = 5000;
const DEFAULT_PREVIEW_BYTES = 256 * 1024;

export type RunArtifactFile = {
  readonly path: string;
  readonly name: string;
  readonly source: 'dag-artifact' | 'run-file';
  readonly artifactId?: string;
  readonly size: number;
  readonly modifiedAt: string;
  readonly mediaType: string;
  readonly previewKind?: FilePreviewKind;
};

export type RunArtifacts = {
  readonly runId: RunId;
  readonly states: ArtifactStates;
  readonly files: readonly RunArtifactFile[];
  readonly truncated: boolean;
};

export type RunArtifactPreview = RunArtifactFile & {
  readonly content: string;
  readonly truncated: boolean;
};

export type RunArtifactDownload = {
  readonly path: string;
  readonly name: string;
  readonly mediaType: string;
  readonly content: Uint8Array;
};

export class RunArtifactError extends Error {
  public constructor(
    public readonly code:
      'ARTIFACT_NOT_FOUND' | 'ARTIFACT_NOT_PREVIEWABLE' | 'RUN_NOT_FOUND' | 'RUN_STATE_UNAVAILABLE',
    message: string,
    public readonly statusCode: 404 | 409 | 415,
  ) {
    super(message);
    this.name = 'RunArtifactError';
  }
}

export class RunArtifactService {
  public constructor(
    private readonly repository: AppRepository,
    private readonly maxFiles = DEFAULT_MAX_FILES,
    private readonly previewBytes = DEFAULT_PREVIEW_BYTES,
  ) {}

  public async list(runId: RunId): Promise<RunArtifacts> {
    const { run, workspace } = await this.#runWorkspace(runId);
    const files: RunArtifactFile[] = [];
    const truncated = await this.#walk(workspace, workspace.root, files, run);
    return {
      runId,
      states: run.checkpoint?.state.artifactStates ?? {},
      files,
      truncated,
    };
  }

  public async preview(runId: RunId, candidate: string): Promise<RunArtifactPreview> {
    const { run, workspace } = await this.#runWorkspace(runId);
    const target = await this.#file(workspace, candidate);
    const info = await stat(target);
    const previewKind = previewKindForPath(target);
    if (previewKind === undefined || previewKind === 'document' || previewKind === 'pdf') {
      throw new RunArtifactError(
        'ARTIFACT_NOT_PREVIEWABLE',
        `Artifact '${candidate}' does not have a text preview.`,
        415,
      );
    }
    const byteLength = Math.min(info.size, this.previewBytes);
    const handle = await open(target, 'r');
    const buffer = Buffer.alloc(byteLength);
    try {
      await handle.read(buffer, 0, byteLength, 0);
    } finally {
      await handle.close();
    }
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(buffer, {
        stream: info.size > byteLength,
      });
    } catch {
      throw new RunArtifactError(
        'ARTIFACT_NOT_PREVIEWABLE',
        `Artifact '${candidate}' is not valid UTF-8 text.`,
        415,
      );
    }
    return {
      ...fileMetadata(workspace, target, info, run),
      previewKind,
      content,
      truncated: info.size > byteLength,
    };
  }

  public async download(runId: RunId, candidate: string): Promise<RunArtifactDownload> {
    const { workspace } = await this.#runWorkspace(runId);
    const target = await this.#file(workspace, candidate);
    return {
      path: displayPath(workspace, target),
      name: basename(target),
      mediaType: mediaTypeForPath(target),
      content: await readFile(target),
    };
  }

  async #runWorkspace(runId: RunId): Promise<{ run: StoredRun; workspace: Workspace }> {
    const run = await this.repository.getRun(runId);
    if (run === undefined) {
      throw new RunArtifactError('RUN_NOT_FOUND', 'Run not found.', 404);
    }
    if (run.checkpoint === undefined) {
      throw new RunArtifactError(
        'RUN_STATE_UNAVAILABLE',
        'Run artifacts are unavailable until the first checkpoint.',
        409,
      );
    }
    return {
      run,
      workspace: await Workspace.open(run.checkpoint.state.workspacePath),
    };
  }

  async #file(workspace: Workspace, candidate: string): Promise<string> {
    let target: string;
    try {
      target = await workspace.resolveExisting(candidate);
    } catch (error) {
      if (fileSystemCode(error) === 'ENOENT') {
        throw new RunArtifactError(
          'ARTIFACT_NOT_FOUND',
          `Artifact '${candidate}' was not found.`,
          404,
        );
      }
      throw error;
    }
    if (!(await stat(target)).isFile()) {
      throw new RunArtifactError(
        'ARTIFACT_NOT_FOUND',
        `Artifact '${candidate}' is not a regular file.`,
        404,
      );
    }
    return target;
  }

  async #walk(
    workspace: Workspace,
    directory: string,
    output: RunArtifactFile[],
    run: StoredRun,
  ): Promise<boolean> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const target = workspace.resolve(relative(workspace.root, join(directory, entry.name)));
      if (entry.isDirectory()) {
        if (await this.#walk(workspace, target, output, run)) return true;
        continue;
      }
      if (!entry.isFile()) continue;
      if (output.length >= this.maxFiles) return true;
      const info = await stat(target);
      output.push(fileMetadata(workspace, target, info, run));
    }
    return false;
  }
}

function fileMetadata(
  workspace: Workspace,
  target: string,
  info: Stats,
  run: StoredRun,
): RunArtifactFile {
  const path = displayPath(workspace, target);
  const artifactId = artifactIdFor(path, run.checkpoint?.state.artifactStates ?? {});
  const previewKind = previewKindForPath(path);
  return {
    path,
    name: basename(target),
    source: artifactId === undefined ? 'run-file' : 'dag-artifact',
    ...(artifactId === undefined ? {} : { artifactId }),
    size: info.size,
    modifiedAt: info.mtime.toISOString(),
    mediaType: mediaTypeForPath(path),
    ...(previewKind === undefined ? {} : { previewKind }),
  };
}

function artifactIdFor(path: string, states: ArtifactStates): string | undefined {
  return Object.entries(states).find(([, state]) =>
    state.paths.some((declaredPath) => {
      const normalized = posix.normalize(declaredPath.replaceAll('\\', '/')).replace(/\/+$/u, '');
      return path === normalized || path.startsWith(`${normalized}/`);
    }),
  )?.[0];
}

function displayPath(workspace: Workspace, target: string): string {
  return relative(workspace.root, target).replaceAll('\\', '/');
}

function fileSystemCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}
