import { createHash } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { extname, posix, resolve } from 'node:path';

import type {
  CapabilityResult,
  ContentReference,
  JsonValue,
  ResultStoragePolicy,
  StoredContent,
} from '../contracts/index.js';
import {
  capabilityResultSchema,
  contentReferenceSchema,
  inlineContent,
  jsonValueSchema,
  resultStoragePolicySchema,
} from '../contracts/index.js';
import { Workspace } from '../capabilities/workspace.js';
import { DagentError, errorMessage } from '../errors.js';

export type NormalizedCapabilityResult = {
  readonly result: CapabilityResult;
  readonly content: StoredContent;
  readonly references: readonly ContentReference[];
  readonly valueReference?: ContentReference;
  readonly originalOutput?: JsonValue;
};

export async function normalizeCapabilityResult(
  result: CapabilityResult,
  options: {
    readonly workspacePath: string;
    readonly runtimeDirectory: string;
    readonly policy?: ResultStoragePolicy;
  },
): Promise<NormalizedCapabilityResult> {
  const policy = resultStoragePolicySchema.parse(options.policy ?? {});
  const references: ContentReference[] = [...result.artifacts];
  let storage:
    | {
        readonly workspace: Workspace;
        readonly resultRoot: string;
      }
    | undefined;
  const openStorage = async () => {
    storage ??= await openResultStorage(options.workspacePath, options.runtimeDirectory);
    return storage;
  };

  const effectiveContent = capabilityResultContent(result);
  const contentBytes = Buffer.from(effectiveContent, 'utf8');
  let storedContent: StoredContent = inlineContent(effectiveContent);
  let normalizedContent = effectiveContent;
  if (contentBytes.byteLength > policy.maxInlineBytes) {
    const { workspace, resultRoot } = await openStorage();
    const reference = await writeReference({
      root: resultRoot,
      workspace,
      filename: `${result.invocationId}-content.txt`,
      data: contentBytes,
      mediaType: 'text/plain; charset=utf-8',
      preview: headTailPreview(effectiveContent, previewLimit(policy)),
    });
    references.push(reference);
    storedContent = reference;
    normalizedContent = reference.preview;
  }

  let normalizedOutput = result.output;
  let valueReference: ContentReference | undefined;
  if (normalizedOutput !== undefined) {
    const encoded = Buffer.from(JSON.stringify(normalizedOutput), 'utf8');
    if (encoded.byteLength > policy.maxInlineBytes) {
      const { workspace, resultRoot } = await openStorage();
      const reference = await writeReference({
        root: resultRoot,
        workspace,
        filename: `${result.invocationId}-value.json`,
        data: encoded,
        mediaType: 'application/json',
        preview: headTailPreview(encoded.toString('utf8'), previewLimit(policy)),
      });
      references.push(reference);
      valueReference = reference;
      normalizedOutput = asJsonValue(reference);
    }
  }

  return {
    result: capabilityResultSchema.parse({
      ...result,
      content: normalizedContent,
      ...(normalizedOutput === undefined ? { output: undefined } : { output: normalizedOutput }),
      artifacts: references,
    }),
    content: storedContent,
    references,
    ...(valueReference === undefined ? {} : { valueReference }),
    ...(result.output === undefined ? {} : { originalOutput: result.output }),
  };
}

function capabilityResultContent(result: CapabilityResult): string {
  if (result.content.length > 0) return result.content;
  if (result.status === 'failed') {
    return `[TOOL_ERROR] ${result.error ?? `Capability '${result.capabilityId}' failed.`}`;
  }
  if (result.status === 'cancelled') {
    return `[TOOL_CANCELLED] ${result.error ?? `Capability '${result.capabilityId}' was cancelled.`}`;
  }
  return '';
}

export type StoredJsonValue = {
  readonly value: JsonValue;
  readonly reference?: ContentReference;
};

/**
 * Bounds persisted DAG values without changing the full in-memory value used
 * for dataflow. The separate reference is trusted provenance; arbitrary JSON
 * that merely looks like a reference is never dereferenced.
 */
export async function externalizeJsonValue(
  value: JsonValue,
  options: {
    readonly workspacePath: string;
    readonly runtimeDirectory: string;
    readonly key: string;
    readonly policy?: ResultStoragePolicy;
  },
): Promise<StoredJsonValue> {
  const policy = resultStoragePolicySchema.parse(options.policy ?? {});
  const encoded = Buffer.from(JSON.stringify(value), 'utf8');
  if (encoded.byteLength <= policy.maxInlineBytes) return { value };

  const { workspace, resultRoot } = await openResultStorage(
    options.workspacePath,
    options.runtimeDirectory,
  );
  const reference = await writeReference({
    root: resultRoot,
    workspace,
    filename: `${options.key}-value.json`,
    data: encoded,
    mediaType: 'application/json',
    preview: headTailPreview(encoded.toString('utf8'), previewLimit(policy)),
  });
  return { value: asJsonValue(reference), reference };
}

async function openResultStorage(
  workspacePath: string,
  runtimeDirectory: string,
): Promise<{ readonly workspace: Workspace; readonly resultRoot: string }> {
  const workspace = await Workspace.open(workspacePath);
  const resultRoot = await workspace.ensureDirectory(`${runtimeDirectory}/results`);
  return { workspace, resultRoot };
}

export async function readReferencedJsonValue(
  referenceInput: ContentReference,
  workspacePath: string,
): Promise<JsonValue> {
  const reference = contentReferenceSchema.parse(referenceInput);
  const workspace = await Workspace.open(workspacePath);
  try {
    const path = await workspace.resolveExisting(reference.path);
    const data = await readFile(path);
    if (data.byteLength !== reference.byteLength) {
      throw new Error(
        `expected ${reference.byteLength} bytes but found ${String(data.byteLength)}`,
      );
    }
    const sha256 = createHash('sha256').update(data).digest('hex');
    if (sha256 !== reference.sha256) {
      throw new Error(`expected sha256 ${reference.sha256} but found ${sha256}`);
    }
    return jsonValueSchema.parse(JSON.parse(data.toString('utf8')) as unknown);
  } catch (error) {
    throw new DagentError(
      'DAG_EXECUTION_FAILED',
      `Cannot restore externalized value '${reference.path}': ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

async function writeReference(options: {
  readonly root: string;
  readonly workspace: Workspace;
  readonly filename: string;
  readonly data: Uint8Array;
  readonly mediaType: string;
  readonly preview: string;
}): Promise<ContentReference> {
  const extension = extname(options.filename).replaceAll(/[^A-Za-z0-9.]/g, '');
  const identity = createHash('sha256').update(options.filename).digest('hex').slice(0, 16);
  const contentDigest = createHash('sha256').update(options.data).digest('hex');
  const safeName = `${identity}-${contentDigest.slice(0, 16)}${extension}`;
  const target = resolve(options.root, safeName);
  options.workspace.resolve(target);
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(options.data);
    await handle.sync();
    await handle.close();
    await rename(temporary, target);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  const relativePath = posix.normalize(
    options.workspace.root === target
      ? safeName
      : target.slice(options.workspace.root.length + 1).replaceAll('\\', '/'),
  );
  return contentReferenceSchema.parse({
    type: 'dagent_content_reference',
    path: relativePath,
    mediaType: options.mediaType || mediaTypeFromExtension(extname(target)),
    byteLength: options.data.byteLength,
    sha256: contentDigest,
    preview: options.preview,
  });
}

function headTailPreview(text: string, limit = 8192): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.7);
  return `${text.slice(0, head)}\n...[EXTERNALIZED]...\n${text.slice(-(limit - head))}`;
}

function previewLimit(policy: ResultStoragePolicy): number {
  return Math.min(8192, Math.max(256, Math.floor(policy.maxInlineBytes / 2)));
}

function mediaTypeFromExtension(extension: string): string {
  const values: Readonly<Record<string, string>> = {
    '.json': 'application/json',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
  };
  return values[extension.toLowerCase()] ?? 'application/octet-stream';
}

export function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
