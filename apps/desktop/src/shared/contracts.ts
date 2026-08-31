import type {
  ApplicationRuntime,
  Conversation,
  ModelProviderInput,
  Project,
  StoredAgent,
  StoredRun,
} from 'dagent-ai-app';
import type { McpServerConfig, RunEvent, ToolAgent } from 'dagent-ai';
import {
  type CapabilityDefinition,
  reviewDecisionSchema,
  reviewLevelSchema,
  runIdSchema,
  toolAgentSchema,
  type ReviewLevel,
} from 'dagent-ai/contracts';
import { z } from 'zod';

export const desktopInvokeChannel = 'dagent-desktop:invoke';
export const desktopRunEventChannel = 'dagent-desktop:run-event';

const idSchema = z.string().trim().min(1).max(300);
const projectCreateSchema = z
  .object({
    action: z.literal('project:create'),
    grantId: idSchema,
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(4000).optional(),
  })
  .strict();

const modelInputSchema = z
  .object({
    id: z
      .string()
      .trim()
      .regex(/^[A-Za-z][A-Za-z0-9_-]*$/u),
    name: z.string().trim().min(1).max(200),
    baseURL: z.url(),
    model: z.string().trim().min(1).max(300),
    apiKey: z.string().max(16_384).optional(),
    apiKeyAction: z.enum(['preserve', 'replace', 'clear']).optional(),
    timeoutMs: z.number().int().min(1000).max(600_000).default(60_000),
    contextWindowTokens: z.number().int().min(1024).max(10_000_000).default(128_000),
    outputReserveTokens: z.number().int().min(0).max(1_000_000).default(8192),
    streamIncludeUsage: z.boolean().default(false),
  })
  .strict()
  .refine((value) => value.outputReserveTokens < value.contextWindowTokens, {
    message: 'Output reserve must be smaller than the context window.',
    path: ['outputReserveTokens'],
  });

const stdioMcpSchema = z
  .object({
    transport: z.literal('stdio'),
    name: z
      .string()
      .trim()
      .regex(/^[A-Za-z][A-Za-z0-9_-]*$/u),
    enabled: z.boolean().default(true),
    command: z.string().trim().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().trim().min(1).optional(),
  })
  .strict();
const httpMcpSchema = z
  .object({
    transport: z.literal('http'),
    name: z
      .string()
      .trim()
      .regex(/^[A-Za-z][A-Za-z0-9_-]*$/u),
    enabled: z.boolean().default(true),
    url: z.url(),
    headers: z.record(z.string(), z.string()).default({}),
  })
  .strict();
const mcpConfigSchema = z.discriminatedUnion('transport', [stdioMcpSchema, httpMcpSchema]);

export const desktopRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('bootstrap') }).strict(),
  z.object({ action: z.literal('dialog:folder') }).strict(),
  z.object({ action: z.literal('dialog:attachments') }).strict(),
  projectCreateSchema,
  z.object({ action: z.literal('project:delete'), projectId: idSchema }).strict(),
  z
    .object({
      action: z.literal('conversation:create'),
      projectId: idSchema.optional(),
      title: z.string().trim().min(1).max(200),
    })
    .strict(),
  z.object({ action: z.literal('conversation:delete'), conversationId: idSchema }).strict(),
  z
    .object({
      action: z.literal('run:start'),
      conversationId: idSchema,
      prompt: z.string().trim().min(1).max(1_000_000),
      capabilityIds: z.array(idSchema).max(256).default([]),
      skillIds: z.array(idSchema).max(64).default([]),
      agentIds: z.array(idSchema).max(32).default([]),
      attachmentGrantIds: z.array(idSchema).max(32).default([]),
      reviewLevel: reviewLevelSchema.default('risky'),
    })
    .strict(),
  z.object({ action: z.literal('run:cancel'), runId: runIdSchema }).strict(),
  z
    .object({
      action: z.literal('run:review'),
      runId: runIdSchema,
      decision: reviewDecisionSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('run:events'),
      runId: runIdSchema,
      after: z.number().int().nonnegative().default(0),
    })
    .strict(),
  z
    .object({
      action: z.literal('file:inspect'),
      projectId: idSchema,
      path: z.string().max(4096).default('.'),
    })
    .strict(),
  z
    .object({
      action: z.literal('file:read'),
      projectId: idSchema,
      path: z.string().min(1).max(4096),
    })
    .strict(),
  z.object({ action: z.literal('changes:get'), runId: runIdSchema }).strict(),
  z.object({ action: z.literal('git:status'), projectId: idSchema }).strict(),
  z
    .object({
      action: z.literal('git:diff'),
      projectId: idSchema,
      path: z.string().min(1).max(4096),
    })
    .strict(),
  z.object({ action: z.literal('resources:list') }).strict(),
  z.object({ action: z.literal('model:create'), input: modelInputSchema }).strict(),
  z.object({ action: z.literal('model:update'), id: idSchema, input: modelInputSchema }).strict(),
  z.object({ action: z.literal('model:activate'), id: idSchema }).strict(),
  z.object({ action: z.literal('model:delete'), id: idSchema }).strict(),
  z.object({ action: z.literal('mcp:create'), config: mcpConfigSchema }).strict(),
  z
    .object({
      action: z.literal('mcp:update'),
      name: idSchema,
      config: mcpConfigSchema,
      secretAction: z.enum(['preserve', 'replace', 'clear']).default('preserve'),
    })
    .strict(),
  z.object({ action: z.literal('mcp:delete'), name: idSchema }).strict(),
  z.object({ action: z.literal('mcp:reload') }).strict(),
  z
    .object({
      action: z.literal('skill:install'),
      content: z.string().min(1).max(2_000_000),
      name: z.string().trim().min(1).max(100).optional(),
      description: z.string().trim().max(1000).optional(),
    })
    .strict(),
  z.object({ action: z.literal('skill:view'), name: idSchema }).strict(),
  z.object({ action: z.literal('skill:delete'), name: idSchema }).strict(),
  z
    .object({
      action: z.literal('agent:save'),
      existingId: idSchema.optional(),
      config: toolAgentSchema,
    })
    .strict(),
  z.object({ action: z.literal('agent:delete'), id: idSchema }).strict(),
]);

export type DesktopRequest = z.input<typeof desktopRequestSchema>;
export type ParsedDesktopRequest = z.output<typeof desktopRequestSchema>;

export type DesktopError = {
  readonly code: string;
  readonly message: string;
};

export type DesktopResult<T = unknown> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: DesktopError };

export type FolderGrant = {
  readonly grantId: string;
  readonly path: string;
  readonly name: string;
};

export type AttachmentGrant = {
  readonly grantId: string;
  readonly name: string;
  readonly size: number;
};

export type FileChange = {
  readonly path: string;
  readonly status: 'added' | 'modified' | 'deleted';
  readonly beforeSize?: number;
  readonly afterSize?: number;
  readonly diff?: string;
};

export type RunChanges = {
  readonly runId: string;
  readonly capturedAt: string;
  readonly truncated: boolean;
  readonly files: readonly FileChange[];
};

export type GitFileStatus = {
  readonly path: string;
  readonly index: string;
  readonly workingTree: string;
  readonly originalPath?: string;
};

export type DesktopResources = {
  readonly models: Awaited<ReturnType<ApplicationRuntime['models']['list']>>;
  readonly mcp: Awaited<ReturnType<ApplicationRuntime['mcpServers']['list']>>;
  readonly skills: Awaited<ReturnType<ApplicationRuntime['skills']['list']>>;
  readonly agents: readonly StoredAgent[];
  readonly capabilities: readonly CapabilityDefinition[];
  readonly profiles: Awaited<ReturnType<ApplicationRuntime['profiles']['list']>>;
};

export type DesktopBootstrap = {
  readonly projects: readonly Project[];
  readonly conversations: readonly Conversation[];
  readonly runs: readonly StoredRun[];
  readonly resources: DesktopResources;
  readonly version: string;
};

export type DesktopRunEvent = {
  readonly event: RunEvent;
};

export type DesktopBridge = {
  invoke(request: DesktopRequest): Promise<DesktopResult>;
  onRunEvent(listener: (event: DesktopRunEvent) => void): () => void;
};

export type { McpServerConfig, ModelProviderInput, ReviewLevel, RunEvent, ToolAgent };
