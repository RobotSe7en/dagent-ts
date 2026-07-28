import { z } from 'zod';

import { capability } from '../capabilities/index.js';
import type {
  Boundary,
  CapabilityDefinition,
  JsonSchema,
  JsonValue,
  RiskLevel,
} from '../contracts/index.js';
import {
  boundarySchema,
  capabilityIdSchema,
  jsonSchemaSchema,
  jsonValueSchema,
  riskLevelSchema,
} from '../contracts/index.js';
import { DagentError } from '../errors.js';
import type { CapabilityBinding, CapabilityExecutionContext } from '../capabilities/index.js';

export type ModuleCapabilityDefinition<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput = JsonValue,
> = {
  readonly id: CapabilityDefinition['id'];
  readonly name?: string;
  readonly description?: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema?: JsonSchema;
  readonly risk?: RiskLevel;
  readonly boundary?: Partial<Boundary>;
  execute(input: TInput, context: CapabilityExecutionContext): TOutput | Promise<TOutput>;
};

/**
 * Import this type with `import type` so a managed module has no runtime
 * dependency on the application package.
 */
export type CapabilityModuleDefinition = {
  readonly schemaVersion: 1;
  readonly capabilities: readonly ModuleCapabilityDefinition[];
};

const metadataSchema = z
  .object({
    id: capabilityIdSchema,
    name: z.string().trim().min(1).optional(),
    description: z.string().optional(),
    inputSchema: jsonSchemaSchema,
    outputSchema: jsonSchemaSchema.optional(),
    risk: riskLevelSchema.optional(),
    boundary: boundarySchema.partial().optional(),
    execute: z.function(),
  })
  .strict();

export function isCapabilityModuleDefinition(value: unknown): value is CapabilityModuleDefinition {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate['schemaVersion'] === 1 && Array.isArray(candidate['capabilities']);
}

export function compileCapabilityModuleDefinition(
  value: unknown,
  source: string,
): readonly CapabilityBinding[] {
  if (!isCapabilityModuleDefinition(value)) {
    throw new DagentError('INVALID_INPUT', 'Export is not a capability module definition.');
  }
  if (value.capabilities.length === 0) {
    throw new DagentError(
      'INVALID_INPUT',
      'A capability module must define at least one capability.',
    );
  }
  return Object.freeze(
    value.capabilities.map((rawCapability) => {
      const definition = metadataSchema.parse(rawCapability);
      const input = schemaValidator(definition.inputSchema, definition.id, 'input');
      const output =
        definition.outputSchema === undefined
          ? jsonValueSchema
          : schemaValidator(definition.outputSchema, definition.id, 'output');
      return capability({
        id: definition.id,
        kind: definition.id.slice(0, definition.id.indexOf('.')) as CapabilityDefinition['kind'],
        ...(definition.name === undefined ? {} : { name: definition.name }),
        ...(definition.description === undefined ? {} : { description: definition.description }),
        input,
        output,
        ...(definition.risk === undefined ? {} : { risk: definition.risk }),
        ...(definition.boundary === undefined
          ? {}
          : { boundary: boundarySchema.parse(definition.boundary) }),
        source,
        execute: definition.execute,
      });
    }),
  );
}

function schemaValidator(
  schema: JsonSchema,
  capabilityId: string,
  role: 'input' | 'output',
): z.ZodType {
  try {
    return z.fromJSONSchema(schema);
  } catch (error) {
    throw new DagentError(
      'INVALID_INPUT',
      `Capability '${capabilityId}' has an invalid ${role} JSON Schema.`,
      { cause: error },
    );
  }
}
