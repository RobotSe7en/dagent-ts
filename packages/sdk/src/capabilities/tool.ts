import { z } from 'zod';

import type {
  Boundary,
  CapabilityDefinition,
  JsonObject,
  JsonValue,
  RiskLevel,
  RunId,
} from '../contracts/index.js';
import { boundarySchema, capabilityDefinitionSchema, jsonValueSchema } from '../contracts/index.js';

export type CapabilityExecutionContext = {
  readonly runId: RunId;
  readonly workspacePath: string;
  readonly signal: AbortSignal;
  readonly metadata: JsonObject;
};

export interface CapabilityBinding<TInput = unknown, TOutput = unknown> {
  readonly definition: CapabilityDefinition;
  readonly input: z.ZodType<TInput>;
  readonly output: z.ZodType<TOutput>;
  execute(input: TInput, context: CapabilityExecutionContext): TOutput | Promise<TOutput>;
}

export function isCapabilityBinding(value: unknown): value is CapabilityBinding {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    capabilityDefinitionSchema.safeParse(candidate['definition']).success &&
    typeof candidate['input'] === 'object' &&
    candidate['input'] !== null &&
    typeof candidate['output'] === 'object' &&
    candidate['output'] !== null &&
    typeof candidate['execute'] === 'function'
  );
}

export type ToolOptions<TInput, TOutput> = {
  readonly id: `tool.${string}`;
  readonly name?: string;
  readonly description?: string;
  readonly input: z.ZodType<TInput>;
  readonly output?: z.ZodType<TOutput>;
  readonly risk?: RiskLevel;
  readonly boundary?: Partial<Boundary>;
  readonly source?: string;
  readonly execute: CapabilityBinding<TInput, TOutput>['execute'];
};

export type CapabilityOptions<TInput, TOutput> = Omit<ToolOptions<TInput, TOutput>, 'id'> & {
  readonly id: CapabilityDefinition['id'];
  readonly kind: CapabilityDefinition['kind'];
};

export function capability<TInput, TOutput = JsonValue>(
  options: CapabilityOptions<TInput, TOutput>,
): CapabilityBinding<TInput, TOutput> {
  const output = options.output ?? (jsonValueSchema as z.ZodType<TOutput>);
  const definition = capabilityDefinitionSchema.parse({
    id: options.id,
    name: options.name ?? options.id.slice(options.id.indexOf('.') + 1),
    description: options.description ?? '',
    kind: options.kind,
    inputSchema: z.toJSONSchema(options.input),
    outputSchema: z.toJSONSchema(output),
    risk: options.risk ?? 'low',
    boundary: boundarySchema.parse(options.boundary ?? {}),
    enabled: true,
    source: options.source ?? 'code',
  });
  return Object.freeze({
    definition: Object.freeze(definition),
    input: options.input,
    output,
    execute: options.execute,
  });
}

export function tool<TInput, TOutput = JsonValue>(
  options: ToolOptions<TInput, TOutput>,
): CapabilityBinding<TInput, TOutput> {
  return capability({
    ...options,
    kind: 'tool',
  });
}
