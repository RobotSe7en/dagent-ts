import { lstat } from 'node:fs/promises';
import { posix } from 'node:path';

import { Workspace } from '../capabilities/workspace.js';
import type {
  Artifact,
  ArtifactState,
  ArtifactStates,
  ArtifactUpload,
  DagNode,
} from '../contracts/index.js';
import { artifactStateSchema, artifactStatesSchema } from '../contracts/index.js';
import { validateArtifactPath, validateUploadFilename } from '../domain/artifact-path.js';
import { DagentError, errorMessage } from '../errors.js';

export class ArtifactWorkspace {
  readonly #workspace: Workspace;
  readonly #artifacts: Readonly<Record<string, Artifact>>;
  readonly #states: Record<string, ArtifactState>;

  private constructor(
    workspace: Workspace,
    artifacts: Readonly<Record<string, Artifact>>,
    states: Record<string, ArtifactState>,
  ) {
    this.#workspace = workspace;
    this.#artifacts = artifacts;
    this.#states = states;
  }

  public static async open(options: {
    readonly workspacePath: string;
    readonly artifacts: Readonly<Record<string, Artifact>>;
    readonly previousStates?: ArtifactStates;
  }): Promise<ArtifactWorkspace> {
    const workspace = await Workspace.open(options.workspacePath);
    const states = Object.fromEntries(
      Object.entries(options.artifacts).map(([id, artifact]) => {
        for (const path of artifact.paths) validateArtifactPath(path);
        const previous = options.previousStates?.[id];
        return [
          id,
          previous !== undefined && samePaths(previous.paths, artifact.paths)
            ? artifactStateSchema.parse(previous)
            : artifactStateSchema.parse({ id, paths: artifact.paths }),
        ];
      }),
    );
    return new ArtifactWorkspace(workspace, options.artifacts, states);
  }

  public snapshot(): ArtifactStates {
    return artifactStatesSchema.parse(this.#states);
  }

  public resolve(artifactId: string): readonly string[] {
    const artifact = this.#artifacts[artifactId];
    if (artifact === undefined) {
      throw new DagentError(
        'DAG_EXECUTION_FAILED',
        `Artifact '${artifactId}' is not declared by this DAG.`,
      );
    }
    return artifact.paths.map((path) => this.#workspace.resolve(path));
  }

  public resolveNode(node: DagNode): {
    readonly inputs: Readonly<Record<string, readonly string[]>>;
    readonly outputs: Readonly<Record<string, readonly string[]>>;
  } {
    return {
      inputs: Object.fromEntries(node.artifactInputs.map((id) => [id, this.resolve(id)])),
      outputs: Object.fromEntries(node.artifactOutputs.map((id) => [id, this.resolve(id)])),
    };
  }

  public async refreshOutputs(node: DagNode): Promise<void> {
    for (const artifactId of node.artifactOutputs) {
      const artifact = this.#artifacts[artifactId];
      if (artifact === undefined) continue;
      const exists = await Promise.all(
        artifact.paths.map(async (path) => this.#pathExistsWithinWorkspace(path)),
      );
      const created = exists.every(Boolean);
      this.#states[artifactId] = artifactStateSchema.parse({
        id: artifact.id,
        paths: artifact.paths,
        status: created ? 'created' : 'missing',
        producerNodeId: node.id,
        ...(created ? {} : { error: 'One or more artifact paths were not created.' }),
      });
    }
  }

  public async materialize(
    uploads: Readonly<Record<string, readonly ArtifactUpload[]>>,
  ): Promise<ReadonlySet<string>> {
    const materialized = new Set<string>();
    for (const [artifactId, files] of Object.entries(uploads)) {
      if (files.length === 0) continue;
      const artifact = this.#artifacts[artifactId];
      if (artifact === undefined) {
        throw new DagentError(
          'INVALID_INPUT',
          `Cannot upload files for unknown artifact '${artifactId}'.`,
        );
      }
      const target = artifact.paths[0];
      if (target === undefined) continue;
      const asDirectory =
        files.length > 1 ||
        isDirectoryLike(target) ||
        files.some(({ filename }) => validateUploadFilename(filename).includes('/'));
      for (const file of files) {
        const filename = validateUploadFilename(file.filename);
        const destination = asDirectory
          ? posix.join(target.replaceAll('\\', '/'), filename)
          : target;
        await this.#workspace.writeFile(destination, file.content);
      }
      this.#states[artifactId] = artifactStateSchema.parse({
        id: artifact.id,
        paths: artifact.paths,
        status: 'created',
      });
      materialized.add(artifactId);
    }
    return materialized;
  }

  public assertRequiredOutputs(): void {
    const failures = Object.entries(this.#artifacts).flatMap(([id, artifact]) => {
      const state = this.#states[id];
      return artifact.required && (state?.status === 'missing' || state?.status === 'failed')
        ? [{ id, state }]
        : [];
    });
    if (failures.length > 0) {
      throw new DagentError(
        'DAG_EXECUTION_FAILED',
        'One or more required DAG artifacts were not created.',
        { details: { artifactStates: this.snapshot(), failures } },
      );
    }
  }

  public markPlannedAsFailed(error: unknown): void {
    for (const [id, state] of Object.entries(this.#states)) {
      if (state.status !== 'planned') continue;
      this.#states[id] = artifactStateSchema.parse({
        ...state,
        status: 'failed',
        error: errorMessage(error),
      });
    }
  }

  async #pathExistsWithinWorkspace(path: string): Promise<boolean> {
    try {
      const resolved = await this.#workspace.resolveExisting(path);
      await lstat(resolved);
      return true;
    } catch (error) {
      if (isMissingPathError(error)) return false;
      throw error;
    }
  }
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

function isDirectoryLike(path: string): boolean {
  return path.endsWith('/') || path.endsWith('\\');
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
