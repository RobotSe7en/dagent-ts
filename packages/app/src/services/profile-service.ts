import { readdir } from 'node:fs/promises';

import type { AgentProfile } from 'dagent-ai';
import {
  DagentError,
  isBuiltinProfileName,
  listBuiltinProfiles,
  loadBuiltinProfile,
  ProfileStore,
} from 'dagent-ai';

export type ProfileSource = 'builtin' | 'managed' | 'config';

export type ProfileDescriptor = AgentProfile & {
  readonly id: `${ProfileSource}:${string}`;
  readonly source: ProfileSource;
  readonly editable: boolean;
  readonly deletable: boolean;
};

export type ProfileWarning = {
  readonly source: Exclude<ProfileSource, 'builtin'>;
  readonly name: string;
  readonly error: string;
};

export class ProfileService {
  readonly #managed: ProfileStore;
  readonly #configured: ProfileStore | undefined;

  public constructor(options: { readonly managedRoot: string; readonly configuredRoot?: string }) {
    this.#managed = new ProfileStore(options.managedRoot);
    this.#configured =
      options.configuredRoot === undefined ? undefined : new ProfileStore(options.configuredRoot);
  }

  public async list(): Promise<{
    readonly profiles: readonly ProfileDescriptor[];
    readonly warnings: readonly ProfileWarning[];
  }> {
    const profiles = (await listBuiltinProfiles()).map((profile) => descriptor(profile, 'builtin'));
    const warnings: ProfileWarning[] = [];
    await this.#appendStore(profiles, warnings, this.#managed, 'managed');
    if (this.#configured !== undefined) {
      await this.#appendStore(profiles, warnings, this.#configured, 'config');
    }
    return { profiles, warnings };
  }

  public async create(name: string, content: string): Promise<ProfileDescriptor> {
    validateContent(content);
    const existing = await this.list();
    if (existing.profiles.some((profile) => profile.name === normalizedName(name))) {
      throw new DagentError('INVALID_INPUT', `Profile '${name}' already exists.`);
    }
    return descriptor(await this.#managed.save(name, content), 'managed');
  }

  public async resolve(name: string): Promise<AgentProfile> {
    const normalized = normalizedName(name);
    for (const store of [this.#managed, this.#configured]) {
      if (store !== undefined && (await store.listNames()).includes(normalized)) {
        return store.load(normalized);
      }
    }
    if (isBuiltinProfileName(normalized)) return loadBuiltinProfile(normalized);
    throw new DagentError('INVALID_INPUT', `Profile '${name}' does not exist.`);
  }

  public async update(name: string, content: string): Promise<ProfileDescriptor | undefined> {
    validateContent(content);
    if (!(await this.#managed.listNames()).includes(normalizedName(name))) return undefined;
    return descriptor(await this.#managed.save(name, content), 'managed');
  }

  public async delete(name: string): Promise<boolean> {
    return this.#managed.delete(name);
  }

  async #appendStore(
    profiles: ProfileDescriptor[],
    warnings: ProfileWarning[],
    store: ProfileStore,
    source: Exclude<ProfileSource, 'builtin'>,
  ): Promise<void> {
    const names = await candidateNames(store.root);
    for (const name of names) {
      try {
        profiles.push(descriptor(await store.load(name), source));
      } catch (error) {
        warnings.push({
          source,
          name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

function descriptor(profile: AgentProfile, source: ProfileSource): ProfileDescriptor {
  const editable = source === 'managed';
  return {
    ...profile,
    id: `${source}:${profile.name}`,
    source,
    editable,
    deletable: editable,
  };
}

async function candidateNames(root: string): Promise<readonly string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
    if (isMissingPathError(error)) return [];
    throw error;
  });
  return entries
    .filter((entry) => entry.name.endsWith('.md'))
    .map((entry) => entry.name.slice(0, -3))
    .sort((left, right) => left.localeCompare(right));
}

function normalizedName(name: string): string {
  return name.trim().replace(/\.md$/u, '');
}

function validateContent(content: string): void {
  if (content.trim().length === 0) {
    throw new DagentError('INVALID_INPUT', 'Profile content is required.');
  }
  if (Buffer.byteLength(content) > 128 * 1024) {
    throw new DagentError('INVALID_INPUT', 'Profile content exceeds 128 KiB.');
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
