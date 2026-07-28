import { z } from 'zod';

import {
  jsonObjectSchema,
  jsonValueSchema,
  runIdSchema,
  runtimeSchemaVersionSchema,
} from './common.js';
import { contextUsageSchema, modelTokenUsageSchema } from './context.js';

export const modelScopeSchema = z.enum([
  'conversation',
  'router',
  'planner',
  'validator',
  'subagent',
  'compactor',
]);
export type ModelScope = z.infer<typeof modelScopeSchema>;

export const itemVisibilitySchema = z.enum(['user', 'internal']);
export type ItemVisibility = z.infer<typeof itemVisibilitySchema>;

export const inlineContentSchema = z
  .object({
    type: z.literal('inline'),
    text: z.string().default(''),
  })
  .strict();
export type InlineContent = z.infer<typeof inlineContentSchema>;

export const contentReferenceSchema = z
  .object({
    type: z.literal('dagent_content_reference'),
    path: z.string().min(1),
    mediaType: z.string().default('application/octet-stream'),
    byteLength: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    preview: z.string().default(''),
  })
  .strict()
  .superRefine(({ path }, context) => {
    if (!isSafeWorkspaceRelativePath(path)) {
      context.addIssue({
        code: 'custom',
        message: 'Content reference path must be workspace-relative and traversal-free.',
        path: ['path'],
      });
    }
  });
export type ContentReference = z.infer<typeof contentReferenceSchema>;

export const storedContentSchema = z.discriminatedUnion('type', [
  inlineContentSchema,
  contentReferenceSchema,
]);
export type StoredContent = z.infer<typeof storedContentSchema>;

export const conversationToolCallSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    arguments: jsonObjectSchema.default({}),
    capabilityId: z.string().optional(),
  })
  .strict();
export type ConversationToolCall = z.infer<typeof conversationToolCallSchema>;

export const attachmentSchema = z
  .object({
    type: z.literal('file').default('file'),
    id: z
      .string()
      .min(1)
      .default(() => `attachment_${crypto.randomUUID()}`),
    path: z.string().min(1),
    mediaType: z.string().default('application/octet-stream'),
    byteLength: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()
  .superRefine(({ path }, context) => {
    if (!isSafeWorkspaceRelativePath(path)) {
      context.addIssue({
        code: 'custom',
        message: 'Attachment path must be workspace-relative and traversal-free.',
        path: ['path'],
      });
    }
  });
export type Attachment = z.infer<typeof attachmentSchema>;

const messageBaseShape = {
  id: z
    .string()
    .min(1)
    .default(() => `msg_${crypto.randomUUID()}`),
  runId: runIdSchema.optional(),
} as const;

export const userMessageSchema = z
  .object({
    ...messageBaseShape,
    type: z.literal('user'),
    content: z.string(),
    attachments: z.array(attachmentSchema).readonly().default([]),
    scope: modelScopeSchema.default('conversation'),
    visibility: itemVisibilitySchema.default('user'),
  })
  .strict();
export type UserMessage = z.infer<typeof userMessageSchema>;

export const assistantMessageSchema = z
  .object({
    ...messageBaseShape,
    type: z.literal('assistant'),
    content: z.string().default(''),
    reasoning: z.string().default(''),
    refusal: z.string().default(''),
    usage: modelTokenUsageSchema.optional(),
    toolCalls: z.array(conversationToolCallSchema).readonly().default([]),
    scope: modelScopeSchema.default('conversation'),
    visibility: itemVisibilitySchema.default('user'),
  })
  .strict();
export type AssistantMessage = z.infer<typeof assistantMessageSchema>;

export const toolResultStatusSchema = z.enum([
  'completed',
  'failed',
  'pending-review',
  'denied',
  'skipped',
]);
export type ToolResultStatus = z.infer<typeof toolResultStatusSchema>;

export const toolResultMessageSchema = z
  .object({
    ...messageBaseShape,
    type: z.literal('tool-result'),
    callId: z.string().min(1),
    name: z.string().min(1),
    capabilityId: z.string().optional(),
    status: toolResultStatusSchema,
    content: storedContentSchema.default({ type: 'inline', text: '' }),
    value: jsonValueSchema.optional(),
    valueReference: contentReferenceSchema.optional(),
    artifacts: z.array(contentReferenceSchema).readonly().default([]),
    scope: modelScopeSchema.default('conversation'),
    visibility: itemVisibilitySchema.default('internal'),
  })
  .strict();
export type ToolResultMessage = z.infer<typeof toolResultMessageSchema>;

export const conversationItemSchema = z.discriminatedUnion('type', [
  userMessageSchema,
  assistantMessageSchema,
  toolResultMessageSchema,
]);
export type ConversationItem = z.infer<typeof conversationItemSchema>;

export const contextSummarySchema = z
  .object({
    content: z.string(),
    sourceItemCount: z.number().int().positive(),
    method: z.enum(['model', 'deterministic-fallback']).default('model'),
    fallbackReason: z.string().optional(),
    sourceTruncated: z.boolean().default(false),
    outputTruncated: z.boolean().default(false),
    reasoning: z.string().default(''),
    usage: modelTokenUsageSchema.optional(),
    contextUsage: contextUsageSchema.optional(),
  })
  .strict();
export type ContextSummary = z.infer<typeof contextSummarySchema>;
export type ContextSummaryInput = z.input<typeof contextSummarySchema>;

export const conversationStateSchema = z
  .object({
    schemaVersion: runtimeSchemaVersionSchema.default(3),
    id: z
      .string()
      .min(1)
      .default(() => `conversation_${crypto.randomUUID()}`),
    revision: z.number().int().nonnegative().default(0),
    summary: contextSummarySchema.optional(),
    items: z.array(conversationItemSchema).readonly().default([]),
  })
  .strict()
  .superRefine(({ items }, context) => {
    const ids = new Set<string>();
    for (const item of items) {
      if (ids.has(item.id)) {
        context.addIssue({
          code: 'custom',
          message: `Conversation item id '${item.id}' is duplicated.`,
          path: ['items'],
        });
      }
      ids.add(item.id);
    }
  });
export type ConversationState = z.infer<typeof conversationStateSchema>;

export function inlineContent(text: string): InlineContent {
  return { type: 'inline', text };
}

export function storedContentText(content: StoredContent): string {
  return content.type === 'inline' ? content.text : content.preview;
}

export function appendConversationItems(
  conversation: ConversationState,
  ...items: readonly ConversationItem[]
): ConversationState {
  return conversationStateSchema.parse({
    ...conversation,
    revision: conversation.revision + 1,
    items: [...conversation.items, ...items],
  });
}

export function isSafeWorkspaceRelativePath(path: string): boolean {
  if (
    path === '' ||
    path.startsWith('/') ||
    path.startsWith('\\') ||
    /^[A-Za-z]:/u.test(path) ||
    path.includes('\\')
  ) {
    return false;
  }
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}
