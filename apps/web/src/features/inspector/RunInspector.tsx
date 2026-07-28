import { useQuery } from '@tanstack/react-query';
import type { RunEvent } from 'dagent-ai';
import {
  Activity,
  BrainCircuit,
  CheckCircle2,
  ChevronRight,
  Circle,
  Wrench,
  X,
} from 'lucide-react';
import { useState } from 'react';

import { api } from '../../api/client.js';
import { useWorkspace } from '../../state/workspace.js';

export function RunInspector() {
  const { inspectorOpen, toggleInspector, runEvents, conversationId } = useWorkspace();
  const [tab, setTab] = useState<'activity' | 'context'>('activity');
  const conversation = useQuery({
    queryKey: ['conversation', conversationId],
    queryFn: () => {
      if (conversationId === undefined) throw new Error('Missing conversation.');
      return api.conversation(conversationId);
    },
    enabled: conversationId !== undefined && inspectorOpen,
  });
  if (!inspectorOpen) return null;
  return (
    <aside className="inspector">
      <header>
        <div>
          <Activity size={16} />
          <strong>Run inspector</strong>
        </div>
        <button className="icon-button" onClick={toggleInspector}>
          <X size={15} />
        </button>
      </header>
      <div className="inspector-tabs">
        <button
          className={tab === 'activity' ? 'active' : ''}
          onClick={() => {
            setTab('activity');
          }}
        >
          Activity
        </button>
        <button
          className={tab === 'context' ? 'active' : ''}
          onClick={() => {
            setTab('context');
          }}
        >
          Context
        </button>
      </div>
      {tab === 'activity' ? (
        <div className="event-list">
          {runEvents.length === 0 ? (
            <p className="muted-copy">运行事件会实时出现在这里。</p>
          ) : (
            runEvents.map((event) => <EventRow key={event.sequence} event={event} />)
          )}
        </div>
      ) : (
        <div className="context-inspector">
          <div className="context-card">
            <BrainCircuit size={17} />
            <div>
              <strong>Public conversation</strong>
              <span>{conversation.data?.conversation.items.length ?? 0} visible items</span>
            </div>
          </div>
          {conversation.data?.contextUsage.at(-1) !== undefined ? (
            <div className="usage-meter">
              <div>
                <span>Estimated input</span>
                <strong>{conversation.data.contextUsage.at(-1)?.estimatedInputTokens ?? 0}</strong>
              </div>
              <div className="meter-track">
                <span
                  style={{
                    width: `${Math.min(
                      100,
                      ((conversation.data.contextUsage.at(-1)?.estimatedInputTokens ?? 0) /
                        (conversation.data.contextUsage.at(-1)?.contextWindowTokens ?? 1)) *
                        100,
                    )}%`,
                  }}
                />
              </div>
            </div>
          ) : null}
          <div className="internal-thread">
            <details>
              <summary>Context boundary</summary>
              <p className="muted-copy">
                私有模型线程、工具结果和验证器续写只在运行时与数据库内部使用，不通过公共 HTTP API
                返回。
              </p>
            </details>
            {conversation.data?.contextUsage.map((usage, index) => (
              <details key={`${usage.estimatedInputTokens}-${index}`}>
                <summary>
                  Context #{index + 1} · {usage.compactionMethod}
                </summary>
                <pre>
                  {JSON.stringify(
                    {
                      estimatedInputTokens: usage.estimatedInputTokens,
                      systemTokens: usage.systemTokens,
                      toolSchemaTokens: usage.toolSchemaTokens,
                      historyTokens: usage.historyTokens,
                      toolResultTokens: usage.toolResultTokens,
                      compactedItems: usage.compactedItems,
                    },
                    null,
                    2,
                  )}
                </pre>
              </details>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}

function EventRow(props: { readonly event: RunEvent }) {
  const label = eventLabel(props.event);
  return (
    <div className="event-row">
      <div className="event-icon">
        {props.event.type === 'capability-started' ? (
          <Wrench size={13} />
        ) : props.event.type.includes('completed') ? (
          <CheckCircle2 size={13} />
        ) : (
          <Circle size={9} />
        )}
      </div>
      <div>
        <strong>{label}</strong>
        <span>#{props.event.sequence}</span>
      </div>
      <ChevronRight size={13} />
    </div>
  );
}

function eventLabel(event: RunEvent): string {
  if (event.type === 'node-started') return `Node · ${event.nodeId}`;
  if (event.type === 'capability-started') {
    return `Tool · ${event.invocation.capabilityId}`;
  }
  if (event.type === 'review-required') return 'Review required';
  if (event.type === 'context-usage') return 'Context measured';
  if (event.type === 'token') return `${event.channel} token`;
  return event.type.replaceAll('-', ' ');
}
