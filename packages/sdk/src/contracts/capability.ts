import { z } from 'zod';

import {
  capabilityIdSchema,
  invocationIdSchema,
  jsonObjectSchema,
  jsonSchemaSchema,
  jsonValueSchema,
} from './common.js';
import { contentReferenceSchema } from './conversation.js';

export const riskLevelSchema = z.enum(['low', 'medium', 'high', 'critical']);
export type RiskLevel = z.infer<typeof riskLevelSchema>;

export const boundarySchema = z
  .object({
    workspaceRead: z.boolean().default(false),
    workspaceWrite: z.boolean().default(false),
    network: z.boolean().default(false),
    process: z.boolean().default(false),
    allowedPaths: z.array(z.string()).default([]),
    allowedHosts: z.array(z.string()).default([]),
  })
  .strict();
export type Boundary = z.infer<typeof boundarySchema>;

export const capabilityDefinitionSchema = z
  .object({
    id: capabilityIdSchema,
    name: z.string().min(1),
    description: z.string().default(''),
    kind: z.enum(['tool', 'mcp', 'agent', 'skill', 'memory']),
    inputSchema: jsonSchemaSchema,
    outputSchema: jsonSchemaSchema.optional(),
    risk: riskLevelSchema.default('low'),
    boundary: boundarySchema.prefault({}),
    enabled: z.boolean().default(true),
    source: z.string().default('runtime'),
  })
  .strict();
export type CapabilityDefinition = z.infer<typeof capabilityDefinitionSchema>;

export const capabilityInvocationSchema = z
  .object({
    id: invocationIdSchema,
    capabilityId: capabilityIdSchema,
    arguments: jsonObjectSchema,
  })
  .strict();
export type CapabilityInvocation = z.infer<typeof capabilityInvocationSchema>;

export const capabilityResultSchema = z
  .object({
    invocationId: invocationIdSchema,
    capabilityId: capabilityIdSchema,
    status: z.enum(['completed', 'failed', 'cancelled']),
    output: jsonValueSchema.optional(),
    content: z.string().default(''),
    error: z.string().optional(),
    metadata: jsonObjectSchema.default({}),
    artifacts: z.array(contentReferenceSchema).readonly().default([]),
  })
  .strict();
export type CapabilityResult = z.infer<typeof capabilityResultSchema>;

export const capabilityScopeSchema = z
  .object({
    capabilities: z.array(capabilityIdSchema).default([]),
    skills: z.array(z.string()).default([]),
    agents: z.array(z.string()).default([]),
  })
  .strict();
export type CapabilityScope = z.infer<typeof capabilityScopeSchema>;
