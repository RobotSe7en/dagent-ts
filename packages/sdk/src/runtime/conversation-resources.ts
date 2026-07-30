import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { extname, join, posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { Workspace } from '../capabilities/workspace.js';
import type {
  ArtifactUpload,
  Attachment,
  ContentReference,
  ConversationState,
} from '../contracts/index.js';
import {
  attachmentSchema,
  contentReferenceSchema,
  conversationStateSchema,
  isSafeWorkspaceRelativePath,
} from '../contracts/index.js';
import { DagentError } from '../errors.js';

const UPLOAD_ROOT = 'uploads';

type ResourceRecord = {
  readonly path: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly sha256: string;
};

export class ConversationResourceStore {
  public constructor(
    private readonly workspaceRoot: string,
    private readonly runtimeDirectory: string,
  ) {}

  public async persist(conversation: ConversationState, workspacePath: string): Promise<void> {
    const records = conversationResources(conversation);
    if (records.length === 0) return;
    const source = await Workspace.open(workspacePath);
    const store = await Workspace.open(
      join(this.workspaceRoot, this.runtimeDirectory, 'conversations'),
    );
    for (const record of records) {
      const data = await verifiedRead(source, record);
      const target = objectPath(conversation.id, record.sha256);
      const existing = await readWorkspaceFile(store, target);
      if (existing !== undefined) {
        verifyBytes(existing, record);
        continue;
      }
      await store.writeFile(target, data, { overwrite: false }).catch(async (error: unknown) => {
        if (!isAlreadyExistsError(error)) throw error;
        const concurrent = await readWorkspaceFile(store, target);
        if (concurrent === undefined) throw error;
        verifyBytes(concurrent, record);
      });
    }
  }

  public async materialize(
    conversation: ConversationState,
    workspacePath: string,
  ): Promise<ConversationState> {
    if (conversationResources(conversation).length === 0) return conversation;
    const destination = await Workspace.open(workspacePath);
    let store: Workspace | undefined;
    const openStore = async () => {
      if (store !== undefined) return store;
      const root = join(this.workspaceRoot, this.runtimeDirectory, 'conversations');
      const exists = await access(root).then(
        () => true,
        (error: unknown) => {
          if (isMissingPathError(error)) return false;
          throw error;
        },
      );
      if (!exists) return undefined;
      store = await Workspace.open(root);
      return store;
    };
    const materialized = new Map<string, string>();

    const rebase = async (record: ResourceRecord): Promise<string> => {
      const existing = materialized.get(record.sha256);
      if (existing !== undefined) return existing;
      const current = await readWorkspaceFile(destination, record.path);
      if (current !== undefined) {
        verifyBytes(current, record);
        materialized.set(record.sha256, record.path);
        return record.path;
      }
      const backingStore = await openStore();
      if (backingStore === undefined) {
        throw new DagentError(
          'WORKSPACE_VIOLATION',
          `Conversation resource is unavailable: ${record.path} (sha256=${record.sha256}).`,
        );
      }
      const data = await readWorkspaceFile(
        backingStore,
        objectPath(conversation.id, record.sha256),
      );
      if (data === undefined) {
        throw new DagentError(
          'WORKSPACE_VIOLATION',
          `Conversation resource is unavailable: ${record.path} (sha256=${record.sha256}).`,
        );
      }
      verifyBytes(data, record);
      const path = `${this.runtimeDirectory}/history/${record.sha256}${safeMediaSuffix(record.mediaType)}`;
      const restored = await readWorkspaceFile(destination, path);
      if (restored === undefined) {
        await destination.writeFile(path, data, { overwrite: false });
      } else {
        verifyBytes(restored, record);
      }
      materialized.set(record.sha256, path);
      return path;
    };

    const items = [];
    for (const item of conversation.items) {
      if (item.type === 'user') {
        const attachments = await Promise.all(
          item.attachments.map(async (attachment) =>
            attachmentSchema.parse({
              ...attachment,
              path: await rebase(attachment),
            }),
          ),
        );
        items.push({ ...item, attachments });
        continue;
      }
      if (item.type === 'tool-result') {
        const content =
          item.content.type === 'dagent_content_reference'
            ? await rebaseReference(item.content, rebase)
            : item.content;
        const valueReference =
          item.valueReference === undefined
            ? undefined
            : await rebaseReference(item.valueReference, rebase);
        const artifacts = await Promise.all(
          item.artifacts.map((reference) => rebaseReference(reference, rebase)),
        );
        items.push({
          ...item,
          content,
          ...(valueReference === undefined
            ? { valueReference: undefined }
            : {
                valueReference,
                value: referenceJson(valueReference),
              }),
          artifacts,
        });
        continue;
      }
      items.push(item);
    }
    if (isDeepStrictEqual(items, conversation.items)) return conversation;
    return conversationStateSchema.parse({
      ...conversation,
      revision: conversation.revision + 1,
      items,
    });
  }
}

export async function materializeInputUploads(
  uploads: readonly ArtifactUpload[],
  workspacePath: string,
): Promise<readonly Attachment[]> {
  if (uploads.length === 0) return [];
  const workspace = await Workspace.open(workspacePath);
  const paths = new Set<string>();
  const attachments: Attachment[] = [];
  for (const upload of uploads) {
    const relative = safeUploadPath(upload.filename);
    if (paths.has(relative)) {
      throw new DagentError('INVALID_INPUT', `Uploaded file path '${relative}' is duplicated.`);
    }
    paths.add(relative);
    const path = `${UPLOAD_ROOT}/${relative}`;
    await workspace.writeFile(path, upload.content, { overwrite: false });
    attachments.push(
      attachmentSchema.parse({
        type: 'file',
        path,
        mediaType: mediaTypeForPath(relative),
        byteLength: upload.content.byteLength,
        sha256: digest(upload.content),
      }),
    );
  }
  return attachments;
}

function conversationResources(conversation: ConversationState): readonly ResourceRecord[] {
  const resources = new Map<string, ResourceRecord>();
  for (const item of conversation.items) {
    if (item.type === 'user') {
      for (const attachment of item.attachments) addResource(resources, attachment);
    } else if (item.type === 'tool-result') {
      if (item.content.type === 'dagent_content_reference') {
        addResource(resources, item.content);
      }
      if (item.valueReference !== undefined) addResource(resources, item.valueReference);
      for (const artifact of item.artifacts) addResource(resources, artifact);
    }
  }
  return [...resources.values()];
}

function addResource(resources: Map<string, ResourceRecord>, record: ResourceRecord): void {
  const identity = `${record.path}\0${record.sha256}`;
  if (!resources.has(identity)) resources.set(identity, record);
}

async function rebaseReference(
  reference: ContentReference,
  rebase: (record: ResourceRecord) => Promise<string>,
): Promise<ContentReference> {
  return contentReferenceSchema.parse({
    ...reference,
    path: await rebase(reference),
  });
}

async function verifiedRead(workspace: Workspace, record: ResourceRecord): Promise<Uint8Array> {
  const path = await workspace.resolveExisting(record.path).catch((error: unknown) => {
    throw new DagentError(
      'WORKSPACE_VIOLATION',
      `Conversation resource cannot be read: ${record.path}.`,
      { cause: error },
    );
  });
  const data = await readFile(path);
  verifyBytes(data, record);
  return data;
}

async function readWorkspaceFile(
  workspace: Workspace,
  path: string,
): Promise<Uint8Array | undefined> {
  const resolved = await workspace.resolveExisting(path).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  });
  return resolved === undefined ? undefined : readFile(resolved);
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

function verifyBytes(data: Uint8Array, record: ResourceRecord): void {
  if (data.byteLength !== record.byteLength) {
    throw new DagentError(
      'WORKSPACE_VIOLATION',
      `Conversation resource size mismatch: ${record.path}.`,
    );
  }
  if (digest(data) !== record.sha256) {
    throw new DagentError(
      'WORKSPACE_VIOLATION',
      `Conversation resource SHA-256 mismatch: ${record.path}.`,
    );
  }
}

function objectPath(conversationId: string, sha256: string): string {
  const conversationKey = createHash('sha256').update(conversationId).digest('hex');
  return `${conversationKey}/${sha256.slice(0, 2)}/${sha256}`;
}

function safeUploadPath(filename: string): string {
  const slashNormalized = filename.replaceAll('\\', '/');
  const normalized = posix.normalize(slashNormalized);
  if (
    !isSafeWorkspaceRelativePath(normalized) ||
    filename.trim() === '' ||
    /^[A-Za-z]:/u.test(filename) ||
    slashNormalized.split('/').includes('..')
  ) {
    throw new DagentError('WORKSPACE_VIOLATION', `Uploaded file name '${filename}' is unsafe.`);
  }
  return normalized;
}

function safeMediaSuffix(mediaType: string): string {
  const suffix = extensionForMediaType(mediaType);
  return /^[.][A-Za-z0-9]{1,10}$/u.test(suffix) ? suffix.toLowerCase() : '';
}

function extensionForMediaType(mediaType: string): string {
  const type = mediaType.split(';', 1)[0]?.toLowerCase();
  const extensions: Readonly<Record<string, string>> = {
    'application/json': '.json',
    'application/pdf': '.pdf',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'text/csv': '.csv',
    'text/markdown': '.md',
    'text/plain': '.txt',
  };
  return type === undefined ? '' : (extensions[type] ?? '');
}

function mediaTypeForPath(path: string): string {
  const extension = extname(path).toLowerCase();
  const values: Readonly<Record<string, string>> = {
    '.csv': 'text/csv; charset=utf-8',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.json': 'application/json',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.md': 'text/markdown; charset=utf-8',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.txt': 'text/plain; charset=utf-8',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  return values[extension] ?? 'application/octet-stream';
}

function digest(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function referenceJson(reference: ContentReference) {
  return {
    type: reference.type,
    path: reference.path,
    mediaType: reference.mediaType,
    byteLength: reference.byteLength,
    sha256: reference.sha256,
    preview: reference.preview,
  };
}
