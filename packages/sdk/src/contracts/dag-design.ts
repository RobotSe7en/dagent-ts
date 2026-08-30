import { z } from 'zod';

import { contextUsageSchema, modelTokenUsageSchema } from './context.js';
import { conversationStateSchema } from './conversation.js';
import { dagSpecSchema } from './dag.js';
import { timestampSchema } from './common.js';

export const dagDiagnosticSchema = z
  .object({
    severity: z.enum(['info', 'warning', 'error']),
    code: z.string().min(1),
    message: z.string().min(1),
    nodeId: z.string().min(1).optional(),
    path: z
      .array(z.union([z.string(), z.number().int().nonnegative()]))
      .readonly()
      .default([]),
  })
  .strict();
export type DagDiagnostic = z.infer<typeof dagDiagnosticSchema>;

export const dagDesignSelectionSchema = z
  .object({ nodeIds: z.array(z.string().min(1)).readonly().default([]) })
  .strict()
  .superRefine(({ nodeIds }, context) => {
    if (new Set(nodeIds).size !== nodeIds.length) {
      context.addIssue({
        code: 'custom',
        message: 'Selected node ids must be unique.',
        path: ['nodeIds'],
      });
    }
  });
export type DagDesignSelection = z.infer<typeof dagDesignSelectionSchema>;

const resultBaseShape = {
  diagnostics: z.array(dagDiagnosticSchema).readonly().default([]),
  conversation: conversationStateSchema,
  usage: modelTokenUsageSchema.optional(),
  contextUsage: contextUsageSchema.optional(),
} as const;

export const dagDesignResultSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...resultBaseShape,
      type: z.literal('proposal'),
      candidate: dagSpecSchema,
      summary: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...resultBaseShape,
      type: z.literal('no-change'),
      summary: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...resultBaseShape,
      type: z.literal('answer'),
      answer: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...resultBaseShape,
      type: z.literal('failure'),
      diagnostics: z.array(dagDiagnosticSchema).min(1).readonly(),
    })
    .strict(),
]);
export type DagDesignResult = z.infer<typeof dagDesignResultSchema>;

const designEventBaseShape = {
  sequence: z.number().int().positive(),
  timestamp: timestampSchema,
} as const;

export const dagDesignEventSchema = z.discriminatedUnion('type', [
  z.object({
    ...designEventBaseShape,
    type: z.literal('response-started'),
    responseId: z.string().min(1),
  }),
  z.object({
    ...designEventBaseShape,
    type: z.literal('reasoning-delta'),
    responseId: z.string().min(1),
    delta: z.string(),
  }),
  z.object({
    ...designEventBaseShape,
    type: z.literal('response-finished'),
    responseId: z.string().min(1),
  }),
  z.object({
    ...designEventBaseShape,
    type: z.literal('validation-started'),
  }),
  z.object({
    ...designEventBaseShape,
    type: z.literal('validation-passed'),
    summary: z.string().min(1),
  }),
]);
export type DagDesignEvent = z.infer<typeof dagDesignEventSchema>;
