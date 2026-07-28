import { z } from 'zod';

import { identifierSchema, riskLevelSchema } from '../contracts/index.js';

const baseServerSchema = z.object({
  name: identifierSchema,
  enabled: z.boolean().default(true),
  risk: riskLevelSchema.default('medium'),
  connectTimeoutMs: z
    .number()
    .int()
    .positive()
    .max(10 * 60 * 1000)
    .default(30_000),
  toolTimeoutMs: z
    .number()
    .int()
    .positive()
    .max(60 * 60 * 1000)
    .default(300_000),
  includeTools: z.array(z.string().trim().min(1)).optional(),
  excludeTools: z.array(z.string().trim().min(1)).optional(),
});

export const mcpStdioServerConfigSchema = baseServerSchema
  .extend({
    transport: z.literal('stdio'),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    cwd: z.string().min(1).optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const mcpHttpServerConfigSchema = baseServerSchema
  .extend({
    transport: z.literal('http'),
    url: z.url(),
    headers: z.record(z.string(), z.string()).default({}),
  })
  .strict();

export const mcpServerConfigSchema = z.discriminatedUnion('transport', [
  mcpStdioServerConfigSchema,
  mcpHttpServerConfigSchema,
]);

export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;
export type McpStdioServerConfig = z.infer<typeof mcpStdioServerConfigSchema>;
export type McpHttpServerConfig = z.infer<typeof mcpHttpServerConfigSchema>;
