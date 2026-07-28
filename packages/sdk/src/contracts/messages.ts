import { z } from 'zod';

import { jsonObjectSchema } from './common.js';
import { modelTokenUsageSchema } from './context.js';

export const messageRoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);
export type MessageRole = z.infer<typeof messageRoleSchema>;

export const providerToolCallSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    arguments: jsonObjectSchema,
  })
  .strict();
export type ProviderToolCall = z.infer<typeof providerToolCallSchema>;

export const chatMessageSchema = z
  .object({
    role: messageRoleSchema,
    content: z.string(),
    name: z.string().min(1).optional(),
    toolCallId: z.string().min(1).optional(),
    toolCalls: z.array(providerToolCallSchema).optional(),
  })
  .strict();
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const chatResponseSchema = z
  .object({
    content: z.string().default(''),
    reasoningContent: z.string().default(''),
    refusal: z.string().default(''),
    toolCalls: z.array(providerToolCallSchema).default([]),
    usage: modelTokenUsageSchema.optional(),
  })
  .strict();
export type ChatResponse = z.infer<typeof chatResponseSchema>;

export const structuredOutputFormatSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().default(''),
    schema: z.record(z.string(), z.unknown()),
    strict: z.boolean().default(true),
  })
  .strict();
export type StructuredOutputFormat = z.infer<typeof structuredOutputFormatSchema>;

export type ChatStreamEvent =
  | {
      readonly type: 'token';
      readonly channel: 'reasoning' | 'content';
      readonly content: string;
    }
  | {
      readonly type: 'done';
      readonly response: ChatResponse;
    };
