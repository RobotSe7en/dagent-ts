import type { DAGSpec, DagNodeResult } from '../contracts/index.js';
import { DagentError } from '../errors.js';

export function graphCapabilityIds(graph: DAGSpec): readonly string[] {
  return unique(
    graph.nodes.flatMap((node) => {
      if (node.kind === 'capability') return [node.capabilityId];
      if (node.kind === 'agent' || node.kind === 'condition') return [];
      return graphCapabilityIds(node.graph);
    }),
  );
}

export function graphAgentIds(graph: DAGSpec): readonly string[] {
  return unique(
    graph.nodes.flatMap((node) => {
      if (node.kind === 'agent') return [node.agentId];
      if (node.kind === 'capability' || node.kind === 'condition') return [];
      return graphAgentIds(node.graph);
    }),
  );
}

export function validateReplanTransition(
  previousGraph: DAGSpec,
  proposedGraph: DAGSpec,
  completedNodeIds: readonly string[],
  rerunNodeIds: readonly string[],
): void {
  const completed = new Set(completedNodeIds);
  const rerun = new Set(rerunNodeIds);
  if (rerun.size !== rerunNodeIds.length) {
    throw new DagentError('DAG_VALIDATION_FAILED', 'rerunNodeIds must be unique.');
  }
  for (const nodeId of rerun) {
    if (!completed.has(nodeId)) {
      throw new DagentError(
        'DAG_VALIDATION_FAILED',
        `rerunNodeIds references non-completed node '${nodeId}'.`,
      );
    }
  }
  const protectedChanges = changedNodeIds(previousGraph, proposedGraph, rerun).filter(
    (nodeId) => completed.has(nodeId) && !rerun.has(nodeId),
  );
  if (protectedChanges.length > 0) {
    throw new DagentError(
      'DAG_VALIDATION_FAILED',
      `Replan changed completed nodes without rerunNodeIds: ${protectedChanges.join(', ')}.`,
    );
  }
}

export function reusableNodeResults(
  previousGraph: DAGSpec,
  proposedGraph: DAGSpec,
  previousResults: Readonly<Record<string, DagNodeResult>>,
  rerunNodeIds: readonly string[],
): Readonly<Record<string, DagNodeResult>> {
  const changed = new Set(changedNodeIds(previousGraph, proposedGraph, new Set(rerunNodeIds)));
  const affected = new Set<string>();
  for (const nodeId of changed) {
    addDownstream(previousGraph, nodeId, affected);
    addDownstream(proposedGraph, nodeId, affected);
  }
  const proposedIds = new Set(proposedGraph.nodes.map(({ id }) => id));
  return Object.fromEntries(
    Object.entries(previousResults).filter(
      ([nodeId]) => proposedIds.has(nodeId) && !affected.has(nodeId),
    ),
  );
}

function changedNodeIds(
  previousGraph: DAGSpec,
  proposedGraph: DAGSpec,
  rerunNodeIds: ReadonlySet<string>,
): readonly string[] {
  const changed = new Set(rerunNodeIds);
  const previousNodes = new Map(previousGraph.nodes.map((node) => [node.id, node]));
  const proposedNodes = new Map(proposedGraph.nodes.map((node) => [node.id, node]));
  for (const nodeId of new Set([...previousNodes.keys(), ...proposedNodes.keys()])) {
    if (JSON.stringify(previousNodes.get(nodeId)) !== JSON.stringify(proposedNodes.get(nodeId))) {
      changed.add(nodeId);
    }
  }

  const previousEdges = new Set(previousGraph.edges.map((edge) => JSON.stringify(edge)));
  const proposedEdges = new Set(proposedGraph.edges.map((edge) => JSON.stringify(edge)));
  for (const serialized of symmetricDifference(previousEdges, proposedEdges)) {
    const edge = JSON.parse(serialized) as { readonly to?: unknown };
    if (typeof edge.to === 'string') changed.add(edge.to);
  }

  const changedArtifacts = new Set<string>();
  for (const artifactId of new Set([
    ...Object.keys(previousGraph.artifacts),
    ...Object.keys(proposedGraph.artifacts),
  ])) {
    if (
      JSON.stringify(previousGraph.artifacts[artifactId]) !==
      JSON.stringify(proposedGraph.artifacts[artifactId])
    ) {
      changedArtifacts.add(artifactId);
    }
  }
  if (changedArtifacts.size > 0) {
    for (const graph of [previousGraph, proposedGraph]) {
      for (const node of graph.nodes) {
        if (
          [...node.artifactInputs, ...node.artifactOutputs].some((artifactId) =>
            changedArtifacts.has(artifactId),
          )
        ) {
          changed.add(node.id);
        }
      }
    }
  }
  return [...changed].sort();
}

function addDownstream(graph: DAGSpec, nodeId: string, affected: Set<string>): void {
  if (!graph.nodes.some(({ id }) => id === nodeId)) return;
  affected.add(nodeId);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of graph.edges) {
      if (affected.has(edge.from) && !affected.has(edge.to)) {
        affected.add(edge.to);
        changed = true;
      }
    }
  }
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function symmetricDifference(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): readonly string[] {
  return [
    ...[...left].filter((value) => !right.has(value)),
    ...[...right].filter((value) => !left.has(value)),
  ];
}
