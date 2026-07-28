import type { RunInput } from 'dagent-ai';
import { jsonValueSchema } from 'dagent-ai/contracts';
import { z } from 'zod';

import { base64StringSchema, decodeBase64 } from './base64.js';

export const staticRunInputSchema = z
  .object({
    graphInput: z.record(z.string(), jsonValueSchema).default({}),
    artifactUploads: z
      .record(
        z.string().min(1),
        z.array(
          z
            .object({
              filename: z.string().min(1),
              contentBase64: base64StringSchema,
            })
            .strict(),
        ),
      )
      .optional(),
  })
  .strict();

export const runInputSchema = z.union([
  z.object({ prompt: z.string().min(1) }).strict(),
  staticRunInputSchema,
]);

export function decodeRunInput(input: z.output<typeof runInputSchema>): RunInput {
  if ('prompt' in input) return input;
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
