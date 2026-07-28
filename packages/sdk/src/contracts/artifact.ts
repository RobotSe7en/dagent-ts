import { z } from 'zod';

import { identifierSchema, jsonObjectSchema } from './common.js';

export const artifactStatusSchema = z.enum(['planned', 'created', 'missing', 'failed']);
export type ArtifactStatus = z.infer<typeof artifactStatusSchema>;

export const artifactSchema = z
  .object({
    id: identifierSchema,
    paths: z.array(z.string().min(1)).min(1),
    description: z.string().default(''),
    required: z.boolean().default(true),
    metadata: jsonObjectSchema.default({}),
  })
  .strict();
export type Artifact = z.infer<typeof artifactSchema>;

export const artifactStateSchema = z
  .object({
    id: identifierSchema,
    paths: z.array(z.string().min(1)).min(1),
    status: artifactStatusSchema.default('planned'),
    producerNodeId: identifierSchema.optional(),
    error: z.string().optional(),
  })
  .strict();
export type ArtifactState = z.infer<typeof artifactStateSchema>;

export const artifactStatesSchema = z.record(identifierSchema, artifactStateSchema);
export type ArtifactStates = z.infer<typeof artifactStatesSchema>;

export type ArtifactUpload = {
  readonly filename: string;
  readonly content: Uint8Array;
};
