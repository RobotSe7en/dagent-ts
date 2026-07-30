import { useMutation } from '@tanstack/react-query';
import { Background, Controls, MiniMap, ReactFlow, type Edge, type Node } from '@xyflow/react';
import type { DAGSpec, RunEvent, RunTarget } from 'dagent-ai';
import { Braces, CheckCircle2, Play, Workflow } from 'lucide-react';
import { useMemo, useState } from 'react';

import { api } from '../../api/client.js';
import { ReviewBanner } from '../run/ReviewBanner.js';
import { useWorkspace } from '../../state/workspace.js';

const initialGraph: DAGSpec = {
  schemaVersion: 1,
  id: 'workspace_graph',
  name: 'Workspace graph',
  description: '',
  nodes: [],
  edges: [],
  artifacts: {},
  output: null,
};

export function DagWorkspace() {
  const {
    projectId,
    conversationId,
    activeRunId: trackedRunId,
    runProjectId,
    runConversationId,
    runEvents: trackedRunEvents,
    beginRun,
  } = useWorkspace();
  const runMatchesSelection = runProjectId === projectId && runConversationId === conversationId;
  const activeRunId = runMatchesSelection ? trackedRunId : undefined;
  const runEvents = runMatchesSelection ? trackedRunEvents : [];
  const [source, setSource] = useState(JSON.stringify(initialGraph, null, 2));
  const [validated, setValidated] = useState<DAGSpec>(initialGraph);
  const [notice, setNotice] = useState('编辑 JSON 后进行校验。');
  const validate = useMutation({
    mutationFn: () => api.validateDag(JSON.parse(source) as unknown),
    onSuccess: ({ graph }) => {
      setValidated(graph);
      setNotice('DAG 合法，可安全进入运行审核。');
    },
    onError: (error) => {
      setNotice(error instanceof Error ? error.message : String(error));
    },
  });
  const run = useMutation({
    mutationFn: async () => {
      const target: RunTarget = {
        kind: 'static-dag',
        graph: validated,
        reviewLevel: 'risky',
      };
      return api.startRun({
        ...(conversationId === undefined ? {} : { conversationId }),
        target,
        input: { graphInput: {} },
      });
    },
    onSuccess: ({ runId }) => {
      beginRun(runId);
    },
  });
  const review = useMemo(
    () =>
      [...runEvents]
        .reverse()
        .find(
          (event): event is Extract<RunEvent, { type: 'review-required' }> =>
            event.type === 'review-required',
        ),
    [runEvents],
  );
  const flow = useMemo(() => toFlow(validated), [validated]);

  return (
    <section className="dag-workspace">
      <header className="workspace-header">
        <div>
          <span className="eyebrow">Typed execution graph</span>
          <h1>DAG Studio</h1>
        </div>
        <div className="header-actions">
          <button
            onClick={() => {
              validate.mutate();
            }}
          >
            <CheckCircle2 size={15} />
            校验
          </button>
          <button
            className="primary"
            disabled={trackedRunId !== undefined}
            onClick={() => {
              run.mutate();
            }}
          >
            <Play size={15} />
            运行
          </button>
        </div>
      </header>
      {review !== undefined && activeRunId !== undefined ? (
        <ReviewBanner
          key={`${review.review.id}:${review.review.revision}`}
          runId={activeRunId}
          event={review}
        />
      ) : null}
      <div className="dag-layout">
        <div className="dag-editor">
          <div className="panel-title">
            <Braces size={15} />
            DAGSpec
          </div>
          <textarea
            spellCheck={false}
            value={source}
            onChange={(event) => {
              setSource(event.target.value);
            }}
          />
          <div className="validation-notice">{notice}</div>
        </div>
        <div className="dag-canvas">
          {flow.nodes.length === 0 ? (
            <div className="canvas-empty">
              <Workflow size={28} />
              <strong>空执行图</strong>
              <span>添加 capability、agent、map、loop 或 subgraph 节点。</span>
            </div>
          ) : (
            <ReactFlow nodes={flow.nodes} edges={flow.edges} fitView>
              <Background color="#d7dbe3" gap={22} />
              <MiniMap pannable zoomable />
              <Controls />
            </ReactFlow>
          )}
        </div>
      </div>
    </section>
  );
}

export function toFlow(graph: DAGSpec): {
  readonly nodes: Node[];
  readonly edges: Edge[];
} {
  const columns = Math.max(1, Math.ceil(Math.sqrt(graph.nodes.length)));
  return {
    nodes: graph.nodes.map((node, index) => ({
      id: node.id,
      position: {
        x: (index % columns) * 230,
        y: Math.floor(index / columns) * 130,
      },
      data: {
        label: `${node.name ?? node.id}\n${node.kind}`,
      },
      style: {
        border: '1px solid #d8dce6',
        borderRadius: 12,
        boxShadow: '0 6px 20px rgba(30, 38, 60, .08)',
        whiteSpace: 'pre-line',
      },
    })),
    edges: graph.edges.map((edge, index) => ({
      id: `${edge.from}-${edge.to}-${index}`,
      source: edge.from,
      target: edge.to,
      animated: edge.condition !== undefined,
    })),
  };
}
