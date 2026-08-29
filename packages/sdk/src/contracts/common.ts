import { z } from 'zod';

export const schemaVersionSchema = z.literal(1);
export type SchemaVersion = z.infer<typeof schemaVersionSchema>;
export const runtimeSchemaVersionSchema = z.literal(3);
export type RuntimeSchemaVersion = z.infer<typeof runtimeSchemaVersionSchema>;
export const checkpointSchemaVersionSchema = z.literal(4);
export type CheckpointSchemaVersion = z.infer<typeof checkpointSchemaVersionSchema>;

export const maxExtraSystemPromptLength = 16_384;

export const runtimeDirectorySchema = z
  .string()
  .refine(isSafeRuntimeDirectory, {
    message: 'Expected a safe, non-empty relative runtime directory.',
  })
  .transform((value) => value.replaceAll('\\', '/'));
export type RuntimeDirectory = z.infer<typeof runtimeDirectorySchema>;

export const extraSystemPromptSchema = z
  .string()
  .max(maxExtraSystemPromptLength)
  .refine((value) => value.trim().length > 0, {
    message: 'extraSystemPrompt must be a non-empty string.',
  });

export const nonEmptyStringSchema = z.string().trim().min(1);
export const identifierSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/, 'Expected an identifier.');
export const capabilityIdSchema = z
  .string()
  .regex(
    /^(?:tool|mcp|agent|skill|memory)\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/,
    'Expected a namespaced capability id.',
  );
export const timestampSchema = z.iso.datetime({ offset: true });

export const runIdSchema = z.string().min(1).brand<'RunId'>();
export type RunId = z.infer<typeof runIdSchema>;
export const reviewIdSchema = z.string().min(1).brand<'ReviewId'>();
export type ReviewId = z.infer<typeof reviewIdSchema>;
export const invocationIdSchema = z.string().min(1).brand<'InvocationId'>();
export type InvocationId = z.infer<typeof invocationIdSchema>;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const jsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), jsonValueSchema);

export const jsonSchemaSchema = z.record(z.string(), z.unknown());
export type JsonSchema = z.infer<typeof jsonSchemaSchema>;

export function nowTimestamp(): string {
  return new Date().toISOString();
}

export function createRunId(): RunId {
  return runIdSchema.parse(`run_${crypto.randomUUID()}`);
}

export function createReviewId(): ReviewId {
  return reviewIdSchema.parse(`review_${crypto.randomUUID()}`);
}

export function createInvocationId(): InvocationId {
  return invocationIdSchema.parse(`inv_${crypto.randomUUID()}`);
}

function isSafeRuntimeDirectory(value: string): boolean {
  if (value.length === 0 || value.startsWith('/') || value.startsWith('\\')) return false;
  if (/^[A-Za-z]:/u.test(value)) return false;
  const segments = value.replaceAll('\\', '/').split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}
