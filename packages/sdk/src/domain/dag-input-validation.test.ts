import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { tool } from '../capabilities/tool.js';
import { defineStaticDag } from '../contracts/agents.js';
import type { DAGSpec } from '../contracts/dag.js';
import { DagInputValidationError } from '../errors.js';
import { Runner } from '../runner.js';
import { MockProvider } from '../testing/mock-provider.js';
import { validateDag } from './dag-validation.js';
import { validateDagInput } from './dag-input-validation.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('DAG input validation', () => {
  it('accepts self-contained Draft 2020-12 resources without applying defaults', () => {
    const schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://example.test/dag-input',
      $defs: {
        payload: {
          $id: 'payload',
          type: 'object',
          properties: {
            name: { type: 'string' },
            count: { type: 'integer', default: 3 },
          },
          required: ['name'],
        },
      },
      $ref: 'payload',
    };
    const input = { name: 'dagent' };

    validateDagInput(schema, input);

    expect(input).toEqual({ name: 'dagent' });
    validateDagInput({ type: 'string' }, 'scalar inputs remain valid');
  });

  it('reports a typed error with instance and schema paths', () => {
    const schema = {
      type: 'object',
      properties: { count: { type: 'integer' } },
      required: ['count'],
    };

    expect(() => validateDagInput(schema, { count: 'three' })).toThrow(DagInputValidationError);
    try {
      validateDagInput(schema, { count: 'three' });
    } catch (error) {
      expect(error).toMatchObject({
        code: 'DAG_INPUT_VALIDATION_FAILED',
        path: ['count'],
      });
      expect(error).toHaveProperty('schemaPath');
      expect(String(error)).toContain('$.count');
    }
  });

  it('rejects invalid and non-self-contained input schemas during graph validation', () => {
    const invalid = validateDag(graphWithSchema({ type: 'not-a-json-schema-type' }));
    const external = validateDag(graphWithSchema({ $ref: 'https://example.test/external-schema' }));

    expect(invalid.valid).toBe(false);
    expect(external.valid).toBe(false);
    if (!invalid.valid) expect(invalid.issues[0]?.path).toBe('inputSchema');
    if (!external.valid) expect(external.issues[0]?.message).toMatch(/self-contained/u);
  });

  it('rejects invalid static input before creating a workspace or invoking capabilities', async () => {
    let calls = 0;
    const record = tool({
      id: 'tool.record-input',
      input: z.object({ count: z.number().int() }).strict(),
      output: z.number().int(),
      execute: ({ count }) => {
        calls += 1;
        return count;
      },
    });
    const root = await temporaryDirectory();
    const workspacePath = join(root, 'invalid-run');
    const runner = new Runner({
      provider: new MockProvider([]),
      capabilities: [record],
      workspace: root,
    });

    try {
      await expect(
        runner.run(
          defineStaticDag(graphWithSchema(validInputSchema)),
          {
            graphInput: { count: 'three' },
          },
          { workspacePath },
        ),
      ).rejects.toBeInstanceOf(DagInputValidationError);
      expect(calls).toBe(0);
      await expect(access(workspacePath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await runner.close();
    }
  });
});

const validInputSchema = {
  type: 'object',
  properties: { count: { type: 'integer' } },
  required: ['count'],
  additionalProperties: false,
} as const;

function graphWithSchema(inputSchema: Readonly<Record<string, unknown>>): DAGSpec {
  return {
    schemaVersion: 1,
    id: 'validated_input',
    name: 'Validated input',
    description: '',
    inputSchema,
    nodes: [
      {
        id: 'record',
        kind: 'capability',
        description: '',
        capabilityId: 'tool.record-input',
        arguments: {
          count: { $expr: { type: 'graph-input', path: ['count'] } },
        },
        artifactInputs: [],
        artifactOutputs: [],
      },
    ],
    edges: [],
    artifacts: {},
    output: { $expr: { type: 'node-output', nodeId: 'record', path: [] } },
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dagent-input-validation-'));
  temporaryDirectories.push(directory);
  return directory;
}
