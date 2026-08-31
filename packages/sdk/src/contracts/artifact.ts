import { z } from 'zod';

import { identifierSchema, jsonObjectSchema } from './common.js';

export const maxArtifactUploadFiles = 256;
export const maxArtifactUploadFileBytes = 25 * 1024 * 1024;
export const maxArtifactUploadTotalBytes = 100 * 1024 * 1024;

const safeArtifactFilePathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.includes('\\') &&
      !value.startsWith('/') &&
      !/^[A-Za-z]:/u.test(value) &&
      value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
    'Artifact file path must be a safe relative POSIX path.',
  );

export const artifactFileRefSchema = z
  .object({
    path: safeArtifactFilePathSchema,
    name: z
      .string()
      .min(1)
      .refine(
        (value) => !value.includes('/') && !value.includes('\\') && value !== '.' && value !== '..',
        {
          message: 'Artifact file name must be a basename.',
        },
      ),
    size: z.number().int().nonnegative(),
    mediaType: z
      .string()
      .refine((value) => value.trim().length > 0 && !value.includes('\r') && !value.includes('\n'))
      .optional(),
  })
  .strict()
  .superRefine(({ path, name }, context) => {
    if (path.split('/').at(-1) !== name) {
      context.addIssue({
        code: 'custom',
        message: 'Artifact file name must match the final path component.',
        path: ['name'],
      });
    }
  });
export type ArtifactFileRef = z.infer<typeof artifactFileRefSchema>;

export const artifactFileManifestSchema = z
  .object({
    artifactId: identifierSchema,
    files: z.array(artifactFileRefSchema).min(1).readonly(),
  })
  .strict()
  .superRefine(({ files }, context) => {
    const paths = files.map(({ path }) => path);
    const sorted = [...new Set(paths)].sort();
    if (paths.length !== sorted.length || paths.some((path, index) => path !== sorted[index])) {
      context.addIssue({
        code: 'custom',
        message: 'Artifact file manifest paths must be unique and sorted.',
        path: ['files'],
      });
    }
  });
export type ArtifactFileManifest = z.infer<typeof artifactFileManifestSchema>;

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
  readonly mediaType?: string;
};
