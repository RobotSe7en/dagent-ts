import { z } from 'zod';

import {
  capabilityIdSchema,
  identifierSchema,
  jsonSchemaSchema,
  jsonValueSchema,
  schemaVersionSchema,
} from './common.js';
import { artifactSchema, type Artifact } from './artifact.js';
import { contentReferenceSchema } from './conversation.js';

export const valueExpressionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('graph-input'),
    path: z.array(z.union([z.string(), z.number().int().nonnegative()])).default([]),
  }),
  z.object({
    type: z.literal('node-output'),
    nodeId: identifierSchema,
    path: z.array(z.union([z.string(), z.number().int().nonnegative()])).default([]),
  }),
  z.object({
    type: z.literal('node-status'),
    nodeId: identifierSchema,
  }),
  z.object({
    type: z.literal('artifact'),
    artifactId: identifierSchema,
    field: z.enum(['path', 'paths', 'absolutePath', 'absolutePaths']).default('path'),
  }),
  z.object({
    type: z.literal('item'),
    path: z.array(z.union([z.string(), z.number().int().nonnegative()])).default([]),
  }),
  z.object({
    type: z.literal('iteration'),
  }),
  z.object({
    type: z.literal('format'),
    template: z.string(),
    values: z.record(z.string(), z.unknown()),
  }),
]);
export type ValueExpression = z.infer<typeof valueExpressionSchema>;

export type ValueBinding =
  | string
  | number
  | boolean
  | null
  | { readonly $expr: ValueExpression }
  | readonly ValueBinding[]
  | { readonly [key: string]: ValueBinding };

export const valueBindingSchema: z.ZodType<ValueBinding> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.object({ $expr: valueExpressionSchema }).strict(),
    z.array(valueBindingSchema),
    z.record(z.string(), valueBindingSchema),
  ]),
);

export const conditionSchema = z.discriminatedUnion('operator', [
  z.object({ operator: z.literal('truthy'), value: valueBindingSchema }),
  z.object({ operator: z.literal('falsy'), value: valueBindingSchema }),
  z.object({
    operator: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte']),
    left: valueBindingSchema,
    right: valueBindingSchema,
  }),
  z.object({
    operator: z.literal('in'),
    value: valueBindingSchema,
    collection: valueBindingSchema,
  }),
]);
export type DagCondition = z.infer<typeof conditionSchema>;

const nodeBaseShape = {
  id: identifierSchema,
  name: z.string().min(1).optional(),
  description: z.string().default(''),
  artifactInputs: z.array(identifierSchema).default([]),
  artifactOutputs: z.array(identifierSchema).default([]),
} as const;

export type DAGSpec = {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: Readonly<Record<string, unknown>> | undefined;
  readonly outputSchema?: Readonly<Record<string, unknown>> | undefined;
  readonly nodes: readonly DagNode[];
  readonly edges: readonly DagEdge[];
  readonly artifacts: Readonly<Record<string, Artifact>>;
  readonly output?: ValueBinding | undefined;
};

export type DagNode =
  | {
      readonly id: string;
      readonly kind: 'capability';
      readonly name?: string | undefined;
      readonly description: string;
      readonly capabilityId: string;
      readonly arguments: Readonly<Record<string, ValueBinding>>;
      readonly artifactInputs: readonly string[];
      readonly artifactOutputs: readonly string[];
    }
  | {
      readonly id: string;
      readonly kind: 'agent';
      readonly name?: string | undefined;
      readonly description: string;
      readonly agentId: string;
      readonly prompt: ValueBinding;
      readonly artifactInputs: readonly string[];
      readonly artifactOutputs: readonly string[];
    }
  | {
      readonly id: string;
      readonly kind: 'subgraph';
      readonly name?: string | undefined;
      readonly description: string;
      readonly graph: DAGSpec;
      readonly input: ValueBinding;
      readonly artifactInputs: readonly string[];
      readonly artifactOutputs: readonly string[];
    }
  | {
      readonly id: string;
      readonly kind: 'map';
      readonly name?: string | undefined;
      readonly description: string;
      readonly items: ValueBinding;
      readonly graph: DAGSpec;
      readonly concurrency: number;
      readonly maxItems: number;
      readonly artifactInputs: readonly string[];
      readonly artifactOutputs: readonly string[];
    }
  | {
      readonly id: string;
      readonly kind: 'loop';
      readonly name?: string | undefined;
      readonly description: string;
      readonly graph: DAGSpec;
      readonly input: ValueBinding;
      readonly until: DagCondition;
      readonly maxIterations: number;
      readonly artifactInputs: readonly string[];
      readonly artifactOutputs: readonly string[];
    };

export type DagEdge = {
  readonly from: string;
  readonly to: string;
  readonly condition?: DagCondition | undefined;
};

export const dagNodeSchema: z.ZodType<DagNode> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z
      .object({
        ...nodeBaseShape,
        kind: z.literal('capability'),
        capabilityId: capabilityIdSchema,
        arguments: z.record(z.string(), valueBindingSchema).default({}),
      })
      .strict(),
    z
      .object({
        ...nodeBaseShape,
        kind: z.literal('agent'),
        agentId: identifierSchema,
        prompt: valueBindingSchema,
      })
      .strict(),
    z
      .object({
        ...nodeBaseShape,
        kind: z.literal('subgraph'),
        graph: dagSpecSchema,
        input: valueBindingSchema,
      })
      .strict(),
    z
      .object({
        ...nodeBaseShape,
        kind: z.literal('map'),
        items: valueBindingSchema,
        graph: dagSpecSchema,
        concurrency: z.number().int().positive().default(4),
        maxItems: z.number().int().positive().default(1000),
      })
      .strict(),
    z
      .object({
        ...nodeBaseShape,
        kind: z.literal('loop'),
        graph: dagSpecSchema,
        input: valueBindingSchema,
        until: conditionSchema,
        maxIterations: z.number().int().positive().max(100),
      })
      .strict(),
  ]),
);

export const dagEdgeSchema: z.ZodType<DagEdge> = z
  .object({
    from: identifierSchema,
    to: identifierSchema,
    condition: conditionSchema.optional(),
  })
  .strict();

export const dagSpecSchema: z.ZodType<DAGSpec> = z.lazy(() =>
  z
    .object({
      schemaVersion: schemaVersionSchema,
      id: identifierSchema,
      name: z.string().min(1),
      description: z.string().default(''),
      inputSchema: jsonSchemaSchema.optional(),
      outputSchema: jsonSchemaSchema.optional(),
      nodes: z.array(dagNodeSchema),
      edges: z.array(dagEdgeSchema),
      artifacts: z.record(identifierSchema, artifactSchema).default({}),
      output: valueBindingSchema.optional(),
    })
    .strict(),
);

export const planProposalSchema = z
  .object({
    graph: dagSpecSchema,
    rationale: z.string().default(''),
    rerunNodeIds: z.array(identifierSchema).default([]),
  })
  .strict();
export type PlanProposal = z.infer<typeof planProposalSchema>;

export const dagNodeResultSchema = z
  .object({
    nodeId: identifierSchema,
    status: z.enum(['pending', 'running', 'completed', 'failed', 'skipped', 'cancelled']),
    output: jsonValueSchema.optional(),
    valueReference: contentReferenceSchema.optional(),
    references: z.array(contentReferenceSchema).readonly().default([]),
    content: z.string().default(''),
    error: z.string().optional(),
    startedAt: z.iso.datetime({ offset: true }).optional(),
    completedAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();
export type DagNodeResult = z.infer<typeof dagNodeResultSchema>;
