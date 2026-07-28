import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { tool } from './capabilities/tool.js';
import { DagBuilder } from './dag-builder.js';

const add = tool({
  id: 'tool.add',
  input: z.object({ left: z.number(), right: z.number() }).strict(),
  output: z.number(),
  execute: ({ left, right }) => left + right,
});

describe('DagBuilder', () => {
  it('builds a frozen, typed graph with explicit dependencies and schemas', () => {
    const builder = new DagBuilder<{ value: number }, number>({
      id: 'typed_graph',
      name: 'Typed graph',
      input: z.object({ value: z.number() }).strict(),
      output: z.number(),
    });
    const first = builder.capability(
      add,
      { left: builder.input('value'), right: 1 },
      { id: 'first' },
    );
    const second = builder.capability(
      add,
      { left: first.output(), right: 2 },
      { id: 'second', after: [first] },
    );
    builder.setOutput(second.output());

    const graph = builder.build();

    expect(graph.edges).toEqual([{ from: 'first', to: 'second' }]);
    expect(graph.output).toEqual({
      $expr: { type: 'node-output', nodeId: 'second', path: [] },
    });
    expect(graph.inputSchema).toMatchObject({ type: 'object' });
    expect(graph.outputSchema).toMatchObject({ type: 'number' });
    expect(Object.isFrozen(graph)).toBe(true);
    expect(Object.isFrozen(graph.nodes)).toBe(true);
  });

  it('rejects implicit node-output dependencies', () => {
    const builder = new DagBuilder({
      id: 'implicit_dependency',
      name: 'Implicit dependency',
    });
    const first = builder.capability(add, { left: 1, right: 2 }, { id: 'first' });
    builder.capability(add, { left: first.output(), right: 3 }, { id: 'second' });

    expect(() => builder.build()).toThrow(/DAG is invalid/u);
  });

  it('rejects duplicate node and artifact identifiers immediately', () => {
    const builder = new DagBuilder({ id: 'duplicates', name: 'Duplicates' });
    builder.capability(add, { left: 1, right: 2 }, { id: 'work' });
    expect(() => builder.capability(add, { left: 2, right: 3 }, { id: 'work' })).toThrow(
      /Duplicate node/u,
    );

    builder.artifact('report', 'report.txt');
    expect(() => builder.artifact('report', 'other.txt')).toThrow(/Duplicate artifact/u);
  });

  it('binds declared artifact paths into capability arguments', () => {
    const builder = new DagBuilder({ id: 'artifacts', name: 'Artifacts' });
    const report = builder.artifact('report', ['reports/final.md'], {
      required: true,
      description: 'Final report',
    });
    builder.capability(
      tool({
        id: 'tool.write-report',
        input: z.object({ path: z.string() }).strict(),
        output: z.string(),
        execute: ({ path }) => path,
      }),
      { path: report.absolutePath() },
      { id: 'write', artifactOutputs: [report] },
    );

    const graph = builder.build();

    expect(graph.artifacts['report']).toMatchObject({
      paths: ['reports/final.md'],
      required: true,
    });
    expect(graph.nodes[0]).toMatchObject({
      artifactOutputs: ['report'],
      arguments: {
        path: {
          $expr: {
            type: 'artifact',
            artifactId: 'report',
            field: 'absolutePath',
          },
        },
      },
    });
  });

  it('builds map graphs with item-scoped references', () => {
    const itemGraph = new DagBuilder<Record<string, never>, number, { value: number }>({
      id: 'map_item',
      name: 'Map item',
      executionScope: 'map',
    });
    const itemResult = itemGraph.capability(
      add,
      { left: itemGraph.item('value'), right: 1 },
      { id: 'increment' },
    );
    itemGraph.setOutput(itemResult.output());

    const root = new DagBuilder<{ values: { value: number }[] }, readonly number[]>({
      id: 'map_root',
      name: 'Map root',
    });
    const mapped = root.map(root.input('values'), itemGraph.build(), {
      id: 'mapped',
      concurrency: 2,
      maxItems: 10,
    });
    root.setOutput(mapped.output());

    expect(root.build().nodes[0]).toMatchObject({
      kind: 'map',
      concurrency: 2,
      maxItems: 10,
    });
  });

  it('builds loop graphs with item and iteration references', () => {
    const loopGraph = new DagBuilder<Record<string, never>, number, number>({
      id: 'loop_body',
      name: 'Loop body',
      executionScope: 'loop',
    });
    const step = loopGraph.capability(
      add,
      { left: loopGraph.iteration(), right: 1 },
      { id: 'step' },
    );
    loopGraph.setOutput(step.output());

    const root = new DagBuilder({ id: 'loop_root', name: 'Loop root' });
    root.loop(
      loopGraph.build(),
      {},
      {
        operator: 'gte',
        left: loopGraph.item().toBinding(),
        right: 2,
      },
      { id: 'loop', maxIterations: 3 },
    );

    expect(root.build().nodes[0]).toMatchObject({
      kind: 'loop',
      maxIterations: 3,
    });
  });

  it('prevents scoped references from being created in the wrong builder', () => {
    const root = new DagBuilder({ id: 'root', name: 'Root' });
    expect(() => root.item()).toThrow(/map or loop/u);
    expect(() => root.iteration()).toThrow(/loop/u);

    const map = new DagBuilder({
      id: 'map',
      name: 'Map',
      executionScope: 'map',
    });
    expect(() => map.iteration()).toThrow(/loop/u);
  });

  it('rejects nested paths on expressions that do not support them', () => {
    const builder = new DagBuilder({ id: 'paths', name: 'Paths' });
    const node = builder.capability(add, { left: 1, right: 2 }, { id: 'node' });
    expect(() => node.status().at('invalid')).toThrow(/does not support nested paths/u);
  });
});
