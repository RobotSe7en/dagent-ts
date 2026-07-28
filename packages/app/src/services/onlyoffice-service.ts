import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { extname } from 'node:path';

import { Workspace } from 'dagent-ai';
import type { RunId } from 'dagent-ai';
import { jsonValueSchema, runIdSchema } from 'dagent-ai/contracts';
import { z } from 'zod';

import type { AppRepository } from '../database/repositories.js';
import type { ProjectFileService } from './project-file-service.js';
import type { RunArtifactService } from './run-artifact-service.js';

const CONFIG_SETTING = 'onlyoffice.config';
const TOKEN_SECRET_SETTING = 'onlyoffice.token-secret';
const DOWNLOAD_LIMIT = 25 * 1024 * 1024;
const VIEW_TOKEN_SECONDS = 10 * 60;
const EDIT_TOKEN_SECONDS = 24 * 60 * 60;

export const onlyOfficeConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    documentServerUrl: z.url().optional(),
    publicApiBase: z.url().optional(),
    jwtSecret: z.string().min(1).optional(),
    lang: z.string().trim().min(1).default('zh'),
    projectFileEditEnabled: z.boolean().default(false),
    runArtifactEditEnabled: z.boolean().default(false),
  })
  .strict();

export type OnlyOfficeConfig = z.infer<typeof onlyOfficeConfigSchema>;
export type OnlyOfficeSecretAction = 'preserve' | 'replace' | 'clear';

const tokenPayloadSchema = z
  .object({
    scope: z.enum(['project', 'run']),
    ownerId: z.string().min(1),
    path: z.string().min(1),
    editable: z.boolean(),
    expiresAt: z.number().int().positive(),
  })
  .strict();
type TokenPayload = z.infer<typeof tokenPayloadSchema>;

export class OnlyOfficeError extends Error {
  public constructor(
    public readonly code:
      | 'ONLYOFFICE_CALLBACK_FAILED'
      | 'ONLYOFFICE_FILE_TOO_LARGE'
      | 'ONLYOFFICE_FORBIDDEN'
      | 'ONLYOFFICE_NOT_CONFIGURED'
      | 'ONLYOFFICE_UNSUPPORTED_FILE',
    message: string,
    public readonly statusCode: 403 | 404 | 413 | 415 | 502,
  ) {
    super(message);
    this.name = 'OnlyOfficeError';
  }
}

export class OnlyOfficeService {
  #config: OnlyOfficeConfig = onlyOfficeConfigSchema.parse({});
  #tokenSecret = '';

  public constructor(
    private readonly repository: AppRepository,
    private readonly projectFiles: ProjectFileService,
    private readonly runArtifacts: RunArtifactService,
  ) {}

  public async initialize(): Promise<void> {
    const storedConfig = await this.repository.setting(CONFIG_SETTING);
    if (storedConfig !== undefined) this.#config = onlyOfficeConfigSchema.parse(storedConfig);
    const storedSecret = await this.repository.setting(TOKEN_SECRET_SETTING);
    if (typeof storedSecret === 'string' && storedSecret.length >= 32) {
      this.#tokenSecret = storedSecret;
      return;
    }
    this.#tokenSecret = randomBytes(32).toString('base64url');
    await this.repository.setSetting(TOKEN_SECRET_SETTING, this.#tokenSecret);
  }

  public settings() {
    const { jwtSecret, ...visible } = this.#config;
    return {
      ...visible,
      jwtSecretConfigured: jwtSecret !== undefined,
    };
  }

  public async update(value: OnlyOfficeConfig, secretAction: OnlyOfficeSecretAction) {
    const parsed = onlyOfficeConfigSchema.parse(value);
    const jwtSecret =
      secretAction === 'clear'
        ? undefined
        : secretAction === 'replace'
          ? parsed.jwtSecret
          : this.#config.jwtSecret;
    this.#config = onlyOfficeConfigSchema.parse({
      ...parsed,
      ...(jwtSecret === undefined ? {} : { jwtSecret }),
    });
    await this.repository.setSetting(CONFIG_SETTING, jsonValueSchema.parse(this.#config));
    return this.settings();
  }

  public async projectConfig(projectId: string, path: string) {
    return this.#editorConfig({
      scope: 'project',
      ownerId: projectId,
      path,
      editable: this.#config.projectFileEditEnabled,
      file: await this.projectFiles.download(projectId, path),
    });
  }

  public async runConfig(runId: RunId, path: string) {
    return this.#editorConfig({
      scope: 'run',
      ownerId: runId,
      path,
      editable: this.#config.runArtifactEditEnabled,
      file: await this.runArtifacts.download(runId, path),
    });
  }

  public async file(token: string) {
    const payload = this.#verifyToken(token);
    return payload.scope === 'project'
      ? this.projectFiles.download(payload.ownerId, payload.path)
      : this.runArtifacts.download(runIdSchema.parse(payload.ownerId), payload.path);
  }

  public async callback(
    token: string,
    input: { readonly status: number; readonly url?: string },
  ): Promise<{ readonly error: 0 }> {
    if (input.status !== 2 && input.status !== 6) return { error: 0 };
    const payload = this.#verifyToken(token);
    if (!payload.editable) {
      throw new OnlyOfficeError(
        'ONLYOFFICE_FORBIDDEN',
        'OnlyOffice callback is not authorized to edit this file.',
        403,
      );
    }
    if (input.url === undefined) {
      throw new OnlyOfficeError(
        'ONLYOFFICE_CALLBACK_FAILED',
        'OnlyOffice callback save URL is required.',
        502,
      );
    }
    const content = await downloadEditedFile(input.url);
    if (payload.scope === 'project') {
      await this.projectFiles.write(payload.ownerId, payload.path, content, {
        overwrite: true,
      });
    } else {
      await this.#writeRunArtifact(runIdSchema.parse(payload.ownerId), payload.path, content);
    }
    return { error: 0 };
  }

  #editorConfig(input: {
    readonly scope: TokenPayload['scope'];
    readonly ownerId: string;
    readonly path: string;
    readonly editable: boolean;
    readonly file: {
      readonly name: string;
      readonly content: Uint8Array;
    };
  }) {
    const config = this.#requireConfigured();
    const documentType = documentTypeForPath(input.path);
    if (documentType === undefined) {
      throw new OnlyOfficeError(
        'ONLYOFFICE_UNSUPPORTED_FILE',
        'File type is not supported by OnlyOffice.',
        415,
      );
    }
    const token = this.#createToken({
      scope: input.scope,
      ownerId: input.ownerId,
      path: input.path,
      editable: input.editable,
      expiresAt:
        Math.floor(Date.now() / 1000) + (input.editable ? EDIT_TOKEN_SECONDS : VIEW_TOKEN_SECONDS),
    });
    const publicApiBase = trimUrl(config.publicApiBase);
    const documentServerUrl = trimUrl(config.documentServerUrl);
    const editorConfig: Record<string, unknown> = {
      documentType,
      type: 'desktop',
      document: {
        fileType: extname(input.path).slice(1).toLowerCase(),
        key: documentKey(input.scope, input.ownerId, input.path, input.file.content),
        title: input.file.name,
        url: `${publicApiBase}/api/v1/onlyoffice/files/${token}`,
        permissions: {
          chat: false,
          comment: false,
          download: true,
          edit: input.editable,
          fillForms: false,
          modifyContentControl: false,
          modifyFilter: false,
          print: true,
          protect: false,
          review: false,
        },
      },
      editorConfig: {
        callbackUrl: `${publicApiBase}/api/v1/onlyoffice/callback/${token}`,
        coEditing: { change: false, mode: 'strict' },
        customization: {
          autosave: false,
          forcesave: input.editable,
          macros: false,
          macrosMode: 'disable',
          plugins: false,
        },
        lang: config.lang,
        mode: input.editable ? 'edit' : 'view',
      },
    };
    if (config.jwtSecret !== undefined) {
      editorConfig['token'] = jwt(editorConfig, config.jwtSecret);
    }
    return {
      documentServerUrl,
      scriptUrl: `${documentServerUrl}/web-apps/apps/api/documents/api.js`,
      config: editorConfig,
    };
  }

  #requireConfigured(): OnlyOfficeConfig & {
    readonly documentServerUrl: string;
    readonly publicApiBase: string;
  } {
    if (
      !this.#config.enabled ||
      this.#config.documentServerUrl === undefined ||
      this.#config.publicApiBase === undefined
    ) {
      throw new OnlyOfficeError('ONLYOFFICE_NOT_CONFIGURED', 'OnlyOffice is not configured.', 404);
    }
    return {
      ...this.#config,
      documentServerUrl: this.#config.documentServerUrl,
      publicApiBase: this.#config.publicApiBase,
    };
  }

  #createToken(payload: TokenPayload): string {
    const content = Buffer.from(JSON.stringify(tokenPayloadSchema.parse(payload)), 'utf8');
    const signature = createHmac('sha256', this.#tokenSecret).update(content).digest();
    return `${content.toString('base64url')}.${signature.toString('base64url')}`;
  }

  #verifyToken(token: string): TokenPayload {
    const [contentValue, signatureValue, extra] = token.split('.');
    if (contentValue === undefined || signatureValue === undefined || extra !== undefined) {
      throw forbiddenToken();
    }
    try {
      const content = Buffer.from(contentValue, 'base64url');
      const signature = Buffer.from(signatureValue, 'base64url');
      const expected = createHmac('sha256', this.#tokenSecret).update(content).digest();
      if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) {
        throw forbiddenToken();
      }
      const payload = tokenPayloadSchema.parse(JSON.parse(content.toString('utf8')));
      if (payload.expiresAt < Math.floor(Date.now() / 1000)) throw forbiddenToken();
      if (documentTypeForPath(payload.path) === undefined) throw forbiddenToken();
      return payload;
    } catch (error) {
      if (error instanceof OnlyOfficeError) throw error;
      throw forbiddenToken();
    }
  }

  async #writeRunArtifact(runId: RunId, path: string, content: Uint8Array): Promise<void> {
    const run = await this.repository.getRun(runId);
    if (run?.checkpoint === undefined) {
      throw new OnlyOfficeError('ONLYOFFICE_FORBIDDEN', 'Run artifact is unavailable.', 403);
    }
    const workspace = await Workspace.open(run.checkpoint.state.workspacePath);
    await workspace.resolveExisting(path);
    await workspace.writeFile(path, content);
  }
}

function documentTypeForPath(path: string): 'word' | 'cell' | 'slide' | undefined {
  switch (extname(path).toLowerCase()) {
    case '.docx':
      return 'word';
    case '.xlsx':
      return 'cell';
    case '.pptx':
      return 'slide';
    default:
      return undefined;
  }
}

function trimUrl(value: string | undefined): string {
  return (value ?? '').replace(/\/+$/u, '');
}

function documentKey(scope: string, ownerId: string, path: string, content: Uint8Array): string {
  return createHash('sha256')
    .update(scope)
    .update('\0')
    .update(ownerId)
    .update('\0')
    .update(path)
    .update('\0')
    .update(content)
    .digest('hex')
    .slice(0, 48);
}

function jwt(payload: unknown, secret: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

function forbiddenToken(): OnlyOfficeError {
  return new OnlyOfficeError(
    'ONLYOFFICE_FORBIDDEN',
    'Invalid or expired OnlyOffice file token.',
    403,
  );
}

async function downloadEditedFile(urlValue: string): Promise<Uint8Array> {
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    throw callbackFailure('OnlyOffice edited file URL is invalid.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw callbackFailure('OnlyOffice edited file URL must use HTTP or HTTPS.');
  }
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(30_000),
      redirect: 'follow',
    });
    if (!response.ok) {
      throw callbackFailure(`OnlyOffice edited file download failed (${response.status}).`);
    }
    const declaredLength = Number(response.headers.get('content-length') ?? '0');
    if (declaredLength > DOWNLOAD_LIMIT) {
      throw new OnlyOfficeError(
        'ONLYOFFICE_FILE_TOO_LARGE',
        `OnlyOffice edited file exceeds ${DOWNLOAD_LIMIT} bytes.`,
        413,
      );
    }
    const content = new Uint8Array(await response.arrayBuffer());
    if (content.byteLength > DOWNLOAD_LIMIT) {
      throw new OnlyOfficeError(
        'ONLYOFFICE_FILE_TOO_LARGE',
        `OnlyOffice edited file exceeds ${DOWNLOAD_LIMIT} bytes.`,
        413,
      );
    }
    return content;
  } catch (error) {
    if (error instanceof OnlyOfficeError) throw error;
    throw callbackFailure(
      `OnlyOffice edited file download failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function callbackFailure(message: string): OnlyOfficeError {
  return new OnlyOfficeError('ONLYOFFICE_CALLBACK_FAILED', message, 502);
}
