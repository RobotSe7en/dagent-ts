import type { RunInput } from 'dagent-ai';
import { jsonValueSchema } from 'dagent-ai/contracts';
import { z } from 'zod';

import { base64StringSchema, decodeBase64 } from './base64.js';

const uploadSchema = z
  .object({
    filename: z.string().min(1),
    contentBase64: base64StringSchema,
  })
  .strict();

export const agentRunInputSchema = z
  .object({
    prompt: z.string().min(1),
    uploads: z.array(uploadSchema).max(32).optional(),
  })
  .strict();

export const staticRunInputSchema = z
  .object({
    graphInput: jsonValueSchema.default({}),
    artifactUploads: z.record(z.string().min(1), z.array(uploadSchema)).optional(),
  })
  .strict();

export const runInputSchema = z.union([agentRunInputSchema, staticRunInputSchema]);

export function decodeRunInput(input: z.output<typeof runInputSchema>): RunInput {
  if ('prompt' in input) {
    return {
      prompt: input.prompt,
      ...(input.uploads === undefined
        ? {}
        : {
            uploads: input.uploads.map((upload) => ({
              filename: upload.filename,
              content: decodeBase64(upload.contentBase64),
            })),
          }),
    };
  }
  return {
    graphInput: input.graphInput,
    ...(input.artifactUploads === undefined
      ? {}
      : {
          artifactUploads: Object.fromEntries(
            Object.entries(input.artifactUploads).map(([artifactId, uploads]) => [
              artifactId,
              uploads.map((upload) => ({
                filename: upload.filename,
                content: decodeBase64(upload.contentBase64),
              })),
            ]),
          ),
        }),
  };
}
