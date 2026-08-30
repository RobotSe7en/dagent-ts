import { readFile, readdir, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DagentError } from '../errors.js';
import { Workspace } from '../capabilities/workspace.js';
import { createAgentProfile, profileTitle, type AgentProfile } from './profile.js';

export const BUILTIN_PROFILE_NAMES = [
  'conversation',
  'dag_agent',
  'dag_design',
  'validator_agent',
  'feedback_learner',
] as const;
export type BuiltinProfileName = (typeof BUILTIN_PROFILE_NAMES)[number];

export class ProfileStore {
  public readonly root: string;

  public constructor(root: string) {
    this.root = resolve(root);
  }

  public async load(name: string): Promise<AgentProfile> {
    const profileName = normalizeProfileName(name);
    let content: string;
    try {
      content = await readFile(this.#path(profileName), 'utf8');
    } catch (error) {
      if (isMissingPathError(error)) {
        throw new DagentError('INVALID_INPUT', `Profile '${profileName}' does not exist.`, {
          cause: error,
        });
      }
      throw error;
    }
    return createAgentProfile({
      name: profileName,
      description: profileTitle(content),
      content,
    });
  }

  public async save(name: string, content: string): Promise<AgentProfile> {
    const profileName = normalizeProfileName(name);
    const workspace = await Workspace.open(this.root);
    await workspace.writeFile(`${profileName}.md`, content);
    return this.load(profileName);
  }

  public async delete(name: string): Promise<boolean> {
    const profileName = normalizeProfileName(name);
    try {
      await unlink(this.#path(profileName));
      return true;
    } catch (error) {
      if (isMissingPathError(error)) return false;
      throw error;
    }
  }

  public async listNames(): Promise<readonly string[]> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch((error: unknown) => {
      if (isMissingPathError(error)) return [];
      throw error;
    });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name.slice(0, -3))
      .filter((name) => isProfileName(name))
      .sort((left, right) => left.localeCompare(right));
  }

  #path(name: string): string {
    return resolve(this.root, `${name}.md`);
  }
}

export async function loadBuiltinProfile(name: BuiltinProfileName): Promise<AgentProfile> {
  return new ProfileStore(builtinProfileRoot()).load(name);
}

export function isBuiltinProfileName(name: string): name is BuiltinProfileName {
  return (BUILTIN_PROFILE_NAMES as readonly string[]).includes(name);
}

export async function listBuiltinProfiles(): Promise<readonly AgentProfile[]> {
  return Promise.all(BUILTIN_PROFILE_NAMES.map(async (name) => loadBuiltinProfile(name)));
}

export function normalizeProfileName(name: string): string {
  const trimmed = name.trim();
  const withoutExtension = trimmed.endsWith('.md') ? trimmed.slice(0, -3) : trimmed;
  if (!isProfileName(withoutExtension)) {
    throw new DagentError(
      'INVALID_INPUT',
      'Profile names must start with a letter and contain only letters, numbers, "_" or "-".',
    );
  }
  return withoutExtension;
}

function isProfileName(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]*$/u.test(name);
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function builtinProfileRoot(): string {
  const moduleUrl: unknown = import.meta.url;
  if (typeof moduleUrl === 'string') {
    return resolve(dirname(fileURLToPath(moduleUrl)), '../../resources/profiles');
  }

  const resourcesPath = (process as unknown as { readonly resourcesPath?: unknown }).resourcesPath;
  if (typeof resourcesPath === 'string') {
    return resolve(resourcesPath, 'profiles');
  }

  throw new Error('Unable to locate the packaged Dagent agent profiles.');
}
