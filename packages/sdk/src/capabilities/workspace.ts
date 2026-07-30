import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { DagentError } from '../errors.js';

export class Workspace {
  public readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  public static async open(root: string): Promise<Workspace> {
    const resolved = resolve(root);
    await mkdir(resolved, { recursive: true });
    return new Workspace(await realpath(resolved));
  }

  public resolve(candidate: string): string {
    if (candidate.includes('\0')) {
      throw new DagentError('WORKSPACE_VIOLATION', 'Workspace paths cannot contain null bytes.');
    }
    const target = isAbsolute(candidate) ? resolve(candidate) : resolve(this.root, candidate);
    const childPath = relative(this.root, target);
    if (childPath === '..' || childPath.startsWith(`..${sep}`) || isAbsolute(childPath)) {
      throw new DagentError(
        'WORKSPACE_VIOLATION',
        `Path '${candidate}' escapes workspace '${this.root}'.`,
      );
    }
    return target;
  }

  public async resolveExisting(candidate: string): Promise<string> {
    const target = await realpath(this.resolve(candidate));
    this.#assertWithin(target);
    return target;
  }

  public async ensureParent(candidate: string): Promise<string> {
    const target = this.resolve(candidate);
    const actualParent = await this.#ensureDirectory(dirname(target));
    const safeTarget = resolve(actualParent, basename(target));
    const info = await lstat(safeTarget).catch(() => undefined);
    if (info?.isSymbolicLink() === true) {
      throw new DagentError(
        'WORKSPACE_VIOLATION',
        `Path '${candidate}' resolves through a symbolic link.`,
      );
    }
    return safeTarget;
  }

  public async ensureDirectory(candidate: string): Promise<string> {
    return this.#ensureDirectory(this.resolve(candidate));
  }

  public async writeFile(
    candidate: string,
    data: string | Uint8Array,
    options: { readonly overwrite?: boolean; readonly mode?: number } = {},
  ): Promise<string> {
    const target = await this.ensureParent(candidate);
    if (options.overwrite === false) {
      const handle = await open(target, 'wx', options.mode ?? 0o600);
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return target;
    }

    const temporary = resolve(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', options.mode ?? 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
      await handle.close();
      await rename(temporary, target);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    return target;
  }

  public async deleteFile(
    candidate: string,
    options: { readonly missingOk?: boolean } = {},
  ): Promise<boolean> {
    const target = this.resolve(candidate);
    const info = await lstat(target).catch((error: unknown) => {
      if (isMissingPathError(error)) return undefined;
      throw error;
    });
    if (info === undefined) {
      if (options.missingOk === true) return false;
      throw new DagentError('INVALID_INPUT', `File '${candidate}' does not exist.`);
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new DagentError(
        'WORKSPACE_VIOLATION',
        `Path '${candidate}' is not a regular workspace file.`,
      );
    }
    await unlink(target);
    return true;
  }

  async #ensureDirectory(target: string): Promise<string> {
    this.#assertWithin(target);
    const childPath = relative(this.root, target);
    if (childPath === '') return this.root;
    let current = this.root;
    for (const segment of childPath.split(sep)) {
      const next = resolve(current, segment);
      const info = await lstat(next).catch((error: unknown) => {
        if (isMissingPathError(error)) return undefined;
        throw error;
      });
      if (info === undefined) {
        await mkdir(next).catch((error: unknown) => {
          if (!isAlreadyExistsError(error)) throw error;
        });
        const actual = await realpath(next);
        this.#assertWithin(actual);
        const actualInfo = await lstat(actual);
        if (!actualInfo.isDirectory()) {
          throw new DagentError('WORKSPACE_VIOLATION', `Path '${next}' is not a directory.`);
        }
        current = actual;
        continue;
      }
      if (!info.isDirectory() && !info.isSymbolicLink()) {
        throw new DagentError('WORKSPACE_VIOLATION', `Path '${next}' is not a directory.`);
      }
      const actual = await realpath(next);
      this.#assertWithin(actual);
      const actualInfo = await lstat(actual);
      if (!actualInfo.isDirectory()) {
        throw new DagentError(
          'WORKSPACE_VIOLATION',
          `Path '${next}' does not resolve to a directory.`,
        );
      }
      current = actual;
    }
    return current;
  }

  #assertWithin(target: string): void {
    const childPath = relative(this.root, target);
    if (childPath === '..' || childPath.startsWith(`..${sep}`) || isAbsolute(childPath)) {
      throw new DagentError(
        'WORKSPACE_VIOLATION',
        `Resolved path '${target}' escapes workspace '${this.root}'.`,
      );
    }
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST'
  );
}
