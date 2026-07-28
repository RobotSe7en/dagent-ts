import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import type { JsonObject } from '../contracts/index.js';
import { jsonObjectSchema } from '../contracts/index.js';
import { DagentError } from '../errors.js';
import { readZipArchive } from './zip.js';

const SKILL_FILE = 'SKILL.md';
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export type SkillEntry = {
  readonly name: string;
  readonly qualifiedName: string;
  readonly description: string;
  readonly category?: string;
  readonly directory: string;
  readonly path: string;
  readonly metadata: JsonObject;
  readonly managed: boolean;
};

export type SkillView = {
  readonly skill: SkillEntry;
  readonly content: string;
  readonly path: string;
  readonly filePath?: string;
  readonly linkedFiles: Readonly<Record<string, readonly string[]>>;
};

export type SkillStoreOptions = {
  readonly roots?: readonly string[];
  readonly managedRoot?: string;
};

export type SkillInstallOptions = {
  readonly name?: string;
  readonly description?: string;
  readonly category?: string;
};

type MarkdownSkill = {
  readonly metadata: JsonObject;
  readonly body: string;
};

export class SkillStore {
  readonly #roots: string[];
  readonly #managedRoot: string;

  public constructor(options: SkillStoreOptions = {}) {
    this.#managedRoot = resolve(options.managedRoot ?? join(homedir(), '.dagent-ts', 'skills'));
    this.#roots = unique(
      [...(options.roots ?? []), this.#managedRoot].map((root) => resolve(root)),
    );
  }

  public get roots(): readonly string[] {
    return this.#roots;
  }

  public get managedRoot(): string {
    return this.#managedRoot;
  }

  public addRoot(root: string): void {
    const resolved = resolve(root);
    if (!this.#roots.includes(resolved)) this.#roots.push(resolved);
  }

  public async list(): Promise<readonly SkillEntry[]> {
    const entries = (
      await Promise.all(this.#roots.map((root) => scanRoot(root, this.#managedRoot)))
    ).flat();
    return entries.sort((left, right) => left.qualifiedName.localeCompare(right.qualifiedName));
  }

  public async view(name: string, filePath?: string): Promise<SkillView> {
    const skill = await this.#resolve(name);
    if (filePath !== undefined) {
      const target = await resolveLinkedFile(skill.directory, filePath);
      return {
        skill,
        content: await readFile(target, 'utf8'),
        path: target,
        filePath,
        linkedFiles: {},
      };
    }
    const parsed = parseMarkdown(await readFile(skill.path, 'utf8'));
    return {
      skill,
      content: parsed.body,
      path: skill.path,
      linkedFiles: await linkedFiles(skill.directory),
    };
  }

  public async installMarkdown(
    content: string,
    options: SkillInstallOptions = {},
  ): Promise<SkillView> {
    return this.#installFiles(new Map([[SKILL_FILE, Buffer.from(content, 'utf8')]]), options);
  }

  public async installArchive(
    content: Uint8Array,
    options: SkillInstallOptions = {},
  ): Promise<SkillView> {
    const entries = readZipArchive(content);
    return this.#installFiles(normalizeArchiveEntries(entries), options);
  }

  async #installFiles(
    files: ReadonlyMap<string, Uint8Array>,
    options: SkillInstallOptions,
  ): Promise<SkillView> {
    const skillFile = files.get(SKILL_FILE);
    if (skillFile === undefined) {
      throw new DagentError('INVALID_INPUT', 'A skill package must contain exactly one SKILL.md.');
    }
    const parsed = parseMarkdown(decodeUtf8(skillFile, SKILL_FILE));
    const name = cleanName(options.name ?? stringMetadata(parsed.metadata, 'name'), 'Skill name');
    const category = cleanOptionalName(
      options.category ?? stringMetadata(parsed.metadata, 'category'),
      'Skill category',
    );
    const description =
      options.description ??
      stringMetadata(parsed.metadata, 'description') ??
      firstParagraph(parsed.body);
    const qualifiedName = category === undefined ? name : `${category}/${name}`;
    if ((await this.list()).some((skill) => skill.qualifiedName === qualifiedName)) {
      throw new DagentError('INVALID_INPUT', `Skill '${qualifiedName}' already exists.`);
    }

    const destination = resolve(
      this.#managedRoot,
      ...(category === undefined ? [name] : [category, name]),
    );
    assertWithin(this.#managedRoot, destination);
    await mkdir(dirname(destination), { recursive: true });
    const staging = join(
      dirname(destination),
      `.${basename(destination)}-${crypto.randomUUID()}.tmp`,
    );
    const metadata = jsonObjectSchema.parse({
      ...parsed.metadata,
      name,
      description,
      ...(category === undefined ? {} : { category }),
    });
    try {
      await mkdir(staging);
      for (const [filePath, fileContent] of files) {
        assertSafeRelativePath(filePath);
        const target = resolve(staging, filePath);
        assertWithin(staging, target);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(
          target,
          filePath === SKILL_FILE
            ? Buffer.from(formatMarkdown(metadata, parsed.body), 'utf8')
            : fileContent,
          { flag: 'wx' },
        );
      }
      await rename(staging, destination);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
    return this.view(qualifiedName);
  }

  public async delete(name: string): Promise<boolean> {
    const skill = await this.#resolve(name);
    const managed = await realpath(this.#managedRoot).catch(() => this.#managedRoot);
    const directory = await realpath(skill.directory);
    if (!skill.managed || directory === managed || !isWithin(managed, directory)) {
      throw new DagentError(
        'WORKSPACE_VIOLATION',
        'Only skills installed under the managed skill root can be deleted.',
      );
    }
    await rm(directory, { recursive: true });
    return true;
  }

  async #resolve(name: string): Promise<SkillEntry> {
    const entries = await this.list();
    const matches = name.includes('/')
      ? entries.filter((entry) => entry.qualifiedName === name)
      : entries.filter((entry) => entry.name === name);
    if (matches.length === 0) {
      throw new DagentError('CAPABILITY_NOT_FOUND', `Skill '${name}' was not found.`);
    }
    if (matches.length > 1) {
      throw new DagentError('INVALID_INPUT', `Skill '${name}' is ambiguous.`, {
        details: { matches: matches.map((entry) => entry.qualifiedName) },
      });
    }
    const match = matches[0];
    if (match === undefined) {
      throw new DagentError('CAPABILITY_NOT_FOUND', `Skill '${name}' was not found.`);
    }
    return match;
  }
}

async function scanRoot(root: string, managedRoot: string): Promise<SkillEntry[]> {
  const rootInfo = await stat(root).catch(() => undefined);
  if (rootInfo?.isDirectory() !== true) return [];
  const candidates: string[] = [];
  for (const first of await directories(root)) {
    const direct = join(root, first, SKILL_FILE);
    if ((await stat(direct).catch(() => undefined))?.isFile() === true) {
      candidates.push(direct);
      continue;
    }
    for (const second of await directories(join(root, first))) {
      const categorized = join(root, first, second, SKILL_FILE);
      if ((await stat(categorized).catch(() => undefined))?.isFile() === true) {
        candidates.push(categorized);
      }
    }
  }
  const entries = await Promise.all(
    candidates.map(async (path): Promise<SkillEntry> => {
      const directory = dirname(path);
      const parsed = parseMarkdown(await readFile(path, 'utf8'));
      const category =
        relative(root, directory).split(sep).length === 2
          ? relative(root, directory).split(sep)[0]
          : stringMetadata(parsed.metadata, 'category');
      const name = stringMetadata(parsed.metadata, 'name') ?? basename(directory);
      const description =
        stringMetadata(parsed.metadata, 'description') ?? firstParagraph(parsed.body);
      return {
        name,
        qualifiedName: category === undefined ? name : `${category}/${name}`,
        description,
        ...(category === undefined ? {} : { category }),
        directory,
        path,
        metadata: parsed.metadata,
        managed: isWithin(managedRoot, directory),
      };
    }),
  );
  return entries;
}

async function directories(path: string): Promise<string[]> {
  return (await readdir(path, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name);
}

async function resolveLinkedFile(skillDirectory: string, filePath: string): Promise<string> {
  if (
    filePath.trim() === '' ||
    isAbsolute(filePath) ||
    filePath.split(/[\\/]/u).some((part) => part === '..' || part === '.')
  ) {
    throw new DagentError('WORKSPACE_VIOLATION', 'Skill file path must be a safe relative path.');
  }
  const root = await realpath(skillDirectory);
  const target = await realpath(resolve(root, filePath)).catch(() => undefined);
  if (target === undefined || !isWithin(root, target)) {
    throw new DagentError('WORKSPACE_VIOLATION', 'Skill file escapes its skill directory.');
  }
  if (!(await stat(target)).isFile()) {
    throw new DagentError('INVALID_INPUT', 'Skill path does not refer to a file.');
  }
  return target;
}

async function linkedFiles(
  skillDirectory: string,
): Promise<Readonly<Record<string, readonly string[]>>> {
  const result: Record<string, readonly string[]> = {};
  for (const group of ['references', 'templates', 'assets', 'scripts']) {
    const directory = join(skillDirectory, group);
    const items = await readdir(directory, { recursive: true, withFileTypes: true }).catch(
      () => [],
    );
    result[group] = items
      .filter((item) => item.isFile())
      .map((item) => relative(skillDirectory, join(item.parentPath, item.name)))
      .sort();
  }
  return result;
}

function parseMarkdown(content: string): MarkdownSkill {
  if (!content.startsWith('---\n')) return { metadata: {}, body: content.trim() };
  const end = content.indexOf('\n---', 4);
  if (end < 0) {
    throw new DagentError('INVALID_INPUT', 'Skill front matter is not terminated.');
  }
  const metadata = jsonObjectSchema.parse(parseYaml(content.slice(4, end)) ?? {});
  return {
    metadata,
    body: content
      .slice(end + 4)
      .replace(/^\r?\n/u, '')
      .trim(),
  };
}

function formatMarkdown(metadata: JsonObject, body: string): string {
  return `---\n${stringifyYaml(metadata).trim()}\n---\n\n${body.trim()}\n`;
}

function stringMetadata(metadata: JsonObject, name: string): string | undefined {
  const value = metadata[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function firstParagraph(content: string): string {
  return (
    content
      .split(/\n\s*\n/u)
      .map((part) => part.replace(/^#+\s*/u, '').trim())
      .find((part) => part !== '') ?? ''
  ).slice(0, 500);
}

function cleanName(value: string | undefined, label: string): string {
  if (value === undefined || !NAME_PATTERN.test(value)) {
    throw new DagentError('INVALID_INPUT', `${label} must match ${String(NAME_PATTERN)}.`);
  }
  return value;
}

function cleanOptionalName(value: string | undefined, label: string): string | undefined {
  return value === undefined ? undefined : cleanName(value, label);
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function assertWithin(root: string, candidate: string): void {
  if (!isWithin(root, candidate) || resolve(root) === resolve(candidate)) {
    throw new DagentError('WORKSPACE_VIOLATION', 'Path escapes the managed skill root.');
  }
}

function normalizeArchiveEntries(
  entries: readonly { readonly path: string; readonly content: Uint8Array }[],
): ReadonlyMap<string, Uint8Array> {
  const skillFiles = entries.filter(
    ({ path }) => path === SKILL_FILE || path.endsWith(`/${SKILL_FILE}`),
  );
  if (skillFiles.length !== 1) {
    throw new DagentError('INVALID_INPUT', 'A skill package must contain exactly one SKILL.md.');
  }
  const skillPath = skillFiles[0]?.path;
  if (skillPath === undefined) {
    throw new DagentError('INVALID_INPUT', 'A skill package must contain SKILL.md.');
  }
  const prefix = skillPath === SKILL_FILE ? '' : skillPath.slice(0, -SKILL_FILE.length);
  const files = new Map<string, Uint8Array>();
  for (const entry of entries) {
    if (prefix !== '' && !entry.path.startsWith(prefix)) {
      throw new DagentError(
        'INVALID_INPUT',
        `ZIP entry '${entry.path}' is outside the skill package root.`,
      );
    }
    const relativePath = prefix === '' ? entry.path : entry.path.slice(prefix.length);
    assertSafeRelativePath(relativePath);
    if (files.has(relativePath)) {
      throw new DagentError('INVALID_INPUT', `Skill package contains duplicate '${relativePath}'.`);
    }
    files.set(relativePath, entry.content);
  }
  return files;
}

function assertSafeRelativePath(path: string): void {
  if (
    path === '' ||
    isAbsolute(path) ||
    path.split(/[\\/]/u).some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new DagentError('WORKSPACE_VIOLATION', `Skill package path '${path}' is unsafe.`);
  }
}

function decodeUtf8(content: Uint8Array, path: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch (error) {
    throw new DagentError('INVALID_INPUT', `Skill file '${path}' must be UTF-8 text.`, {
      cause: error,
    });
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
