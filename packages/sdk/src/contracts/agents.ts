import { z } from 'zod';

import { capabilityScopeSchema } from './capability.js';
import { contextPolicySchema } from './context.js';
import { dagSpecSchema } from './dag.js';

export const reviewLevelSchema = z.enum(['never', 'risky', 'always']);
export type ReviewLevel = z.infer<typeof reviewLevelSchema>;

const agentBaseShape = {
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
  name: z.string().min(1),
  description: z.string().default(''),
  systemPrompt: z.string().default(''),
  scope: capabilityScopeSchema.prefault({}),
  reviewLevel: reviewLevelSchema.default('risky'),
  context: contextPolicySchema.prefault({}),
} as const;

export const toolAgentSchema = z
  .object({
    ...agentBaseShape,
    kind: z.literal('tool-agent'),
    maxSteps: z.number().int().positive().default(20),
  })
  .strict();
export type ToolAgent = z.infer<typeof toolAgentSchema>;

export const dagAgentSchema = z
  .object({
    ...agentBaseShape,
    kind: z.literal('dag-agent'),
    maxReplans: z.number().int().nonnegative().default(3),
  })
  .strict();
export type DagAgent = z.infer<typeof dagAgentSchema>;

export const autoAgentSchema = z
  .object({
    ...agentBaseShape,
    kind: z.literal('auto-agent'),
    toolAgent: toolAgentSchema,
    dagAgent: dagAgentSchema,
  })
  .strict();
export type AutoAgent = z.infer<typeof autoAgentSchema>;

export const staticDagTargetSchema = z
  .object({
    kind: z.literal('static-dag'),
    graph: dagSpecSchema,
    reviewLevel: reviewLevelSchema.default('never'),
  })
  .strict();
export type StaticDagTarget = z.infer<typeof staticDagTargetSchema>;

export const runTargetSchema = z.discriminatedUnion('kind', [
  toolAgentSchema,
  dagAgentSchema,
  autoAgentSchema,
  staticDagTargetSchema,
]);
export type RunTarget = z.infer<typeof runTargetSchema>;

export function defineToolAgent(input: z.input<typeof toolAgentSchema>): ToolAgent {
  return Object.freeze(toolAgentSchema.parse(input));
}

export function defineDagAgent(input: z.input<typeof dagAgentSchema>): DagAgent {
  return Object.freeze(dagAgentSchema.parse(input));
}

export function defineAutoAgent(input: z.input<typeof autoAgentSchema>): AutoAgent {
  return Object.freeze(autoAgentSchema.parse(input));
}

export function defineStaticDag(
  graph: z.input<typeof dagSpecSchema>,
  reviewLevel: ReviewLevel = 'never',
): StaticDagTarget {
  return Object.freeze(staticDagTargetSchema.parse({ kind: 'static-dag', graph, reviewLevel }));
}
