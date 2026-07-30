import { describe, expect, it } from 'vitest';

import type { DAGSpec, DagNodeResult } from '../contracts/index.js';
import { reusableNodeResults, validateReplanTransition } from './dag-transition.js';

describe('DAG replan transitions', () => {
  it('invalidates a completed target when only its incoming edge changes', () => {
    const previous = graph([{ from: 'source', to: 'sink' }]);
    const proposed = graph([
      { from: 'source', to: 'middle' },
      { from: 'middle', to: 'sink' },
    ]);
    const results = {
      source: completed('source'),
      sink: completed('sink'),
    };

    validateReplanTransition(previous, proposed, ['source', 'sink'], ['sink']);
    const reusable = reusableNodeResults(previous, proposed, results, ['sink']);

    expect(Object.keys(reusable)).toEqual(['source']);
  });
});

function graph(edges: DAGSpec['edges']): DAGSpec {
  return {
    schemaVersion: 1,
    id: 'edge_replan',
    name: 'Edge replan',
    description: '',
    nodes: ['source', 'middle', 'sink'].map((id) => ({
      id,
      kind: 'capability' as const,
      description: '',
      capabilityId: 'tool.echo',
      arguments: {},
      artifactInputs: [],
      artifactOutputs: [],
    })),
    edges,
    artifacts: {},
  };
}

function completed(nodeId: string): DagNodeResult {
  return {
    nodeId,
    status: 'completed',
    output: nodeId,
    references: [],
    content: nodeId,
  };
}
