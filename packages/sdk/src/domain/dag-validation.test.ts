import { describe, expect, it } from 'vitest';

import { validateDag } from './dag-validation.js';

describe('validateDag', () => {
  it('requires explicit upstream edges for node references', () => {
    const result = validateDag({
      schemaVersion: 1,
      id: 'graph',
      name: 'Graph',
      nodes: [
        {
          id: 'first',
          kind: 'capability',
          capabilityId: 'tool.first',
          arguments: {},
        },
        {
          id: 'second',
          kind: 'capability',
          capabilityId: 'tool.second',
          arguments: {
            value: {
              $expr: { type: 'node-output', nodeId: 'first', path: [] },
            },
          },
        },
      ],
      edges: [],
      artifacts: {},
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.some(({ code }) => code === 'invalid-reference')).toBe(true);
    }
  });

  it('rejects cycles', () => {
    const result = validateDag({
      schemaVersion: 1,
      id: 'graph',
      name: 'Graph',
      nodes: [
        { id: 'a', kind: 'capability', capabilityId: 'tool.a', arguments: {} },
        { id: 'b', kind: 'capability', capabilityId: 'tool.b', arguments: {} },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
      ],
      artifacts: {},
    });
    expect(result.valid).toBe(false);
  });

  it.each(['../outside.md', '/tmp/outside.md', 'C:/outside.md'])(
    'rejects unsafe artifact paths: %s',
    (path) => {
      const result = validateDag({
        schemaVersion: 1,
        id: 'graph',
        name: 'Graph',
        nodes: [],
        edges: [],
        artifacts: {
          report: { id: 'report', paths: [path] },
        },
      });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.issues).toContainEqual(expect.objectContaining({ code: 'invalid-artifact' }));
      }
    },
  );

  it('rejects multiple producers for one artifact', () => {
    const result = validateDag({
      schemaVersion: 1,
      id: 'graph',
      name: 'Graph',
      nodes: [
        {
          id: 'first',
          kind: 'capability',
          capabilityId: 'tool.first',
          arguments: {},
          artifactOutputs: ['report'],
        },
        {
          id: 'second',
          kind: 'capability',
          capabilityId: 'tool.second',
          arguments: {},
          artifactOutputs: ['report'],
        },
      ],
      edges: [{ from: 'first', to: 'second' }],
      artifacts: { report: { id: 'report', paths: ['report.md'] } },
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.some(({ message }) => message.includes('produced by both'))).toBe(true);
    }
  });

  it('requires artifact consumers to depend on their producer', () => {
    const result = validateDag({
      schemaVersion: 1,
      id: 'graph',
      name: 'Graph',
      nodes: [
        {
          id: 'producer',
          kind: 'capability',
          capabilityId: 'tool.first',
          arguments: {},
          artifactOutputs: ['report'],
        },
        {
          id: 'consumer',
          kind: 'capability',
          capabilityId: 'tool.second',
          arguments: {},
          artifactInputs: ['report'],
        },
      ],
      edges: [],
      artifacts: { report: { id: 'report', paths: ['report.md'] } },
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.some(({ message }) => message.includes("producer 'producer'"))).toBe(
        true,
      );
    }
  });
});
