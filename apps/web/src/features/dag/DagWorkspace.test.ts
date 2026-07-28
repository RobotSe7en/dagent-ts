import type { DAGSpec } from 'dagent-ai';
import { describe, expect, it } from 'vitest';

import { toFlow } from './DagWorkspace.js';

describe('DAG canvas projection', () => {
  it('keeps canonical node ids and conditional edge state', () => {
    const graph: DAGSpec = {
      schemaVersion: 1,
      id: 'test_graph',
      name: 'Test',
      description: '',
      nodes: [
        {
          id: 'first',
          kind: 'capability',
          description: '',
          capabilityId: 'tool.first',
          arguments: {},
          artifactInputs: [],
          artifactOutputs: [],
        },
        {
          id: 'second',
          kind: 'capability',
          description: '',
          capabilityId: 'tool.second',
          arguments: {},
          artifactInputs: [],
          artifactOutputs: [],
        },
      ],
      edges: [
        {
          from: 'first',
          to: 'second',
          condition: { operator: 'truthy', value: true },
        },
      ],
      artifacts: {},
    };

    const flow = toFlow(graph);

    expect(flow.nodes.map((node) => node.id)).toEqual(['first', 'second']);
    expect(flow.edges[0]).toMatchObject({
      source: 'first',
      target: 'second',
      animated: true,
    });
  });
});
