import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConversationItem, RunEvent, RunTarget } from 'dagent-ai';
import {
  Bot,
  CircleStop,
  CornerDownLeft,
  LoaderCircle,
  MessageSquareText,
  UserRound,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { api, subscribeRun } from '../../api/client.js';
import { EmptyState } from '../../components/EmptyState.js';
import { useWorkspace } from '../../state/workspace.js';

export function ChatWorkspace() {
  const queryClient = useQueryClient();
  const { conversationId, activeRunId, beginRun, appendRunEvent, clearRun, runEvents } =
    useWorkspace();
  const [prompt, setPrompt] = useState('');
  const [streamedContent, setStreamedContent] = useState('');
  const [streamError, setStreamError] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const conversation = useQuery({
    queryKey: ['conversation', conversationId],
    queryFn: () => {
      if (conversationId === undefined) throw new Error('Missing conversation.');
      return api.conversation(conversationId);
    },
    enabled: conversationId !== undefined,
  });
  const capabilities = useQuery({
    queryKey: ['capabilities'],
    queryFn: api.capabilities,
  });
  const start = useMutation({
    mutationFn: async (text: string) => {
      if (conversationId === undefined) throw new Error('Select a conversation.');
      const target = toolAgent(
        capabilities.data
          ?.filter((capability) => capability.kind !== 'skill')
          .map((capability) => capability.id) ?? [],
      );
      return api.startRun({
        conversationId,
        target,
        input: { prompt: text },
      });
    },
    onSuccess: ({ runId }) => {
      setPrompt('');
      setStreamedContent('');
      setStreamError('');
      beginRun(runId);
    },
  });

  useEffect(() => {
    if (activeRunId === undefined) return;
    return subscribeRun(
      activeRunId,
      (event) => {
        appendRunEvent(event);
        if (event.type === 'token' && event.channel === 'content') {
          setStreamedContent((content) => content + event.content);
        }
        if (event.type === 'run-completed') {
          clearRun();
          void queryClient.invalidateQueries({
            queryKey: ['conversation', conversationId],
          });
        }
      },
      () => {
        setStreamError('连接暂时中断，正在自动恢复事件流。');
      },
    );
  }, [activeRunId, appendRunEvent, clearRun, conversationId, queryClient]);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [conversation.data?.revision, streamedContent, runEvents.length]);

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

  if (conversationId === undefined) {
    return (
      <EmptyState
        icon={<MessageSquareText size={28} />}
        title="选择一个对话"
        description="从左侧项目中新建或打开对话，历史记录会按会话独立保存。"
      />
    );
  }

  const items =
    conversation.data?.conversation.items.filter(
      (item): item is Exclude<ConversationItem, { type: 'tool-result' }> =>
        item.visibility === 'user' && item.type !== 'tool-result',
    ) ?? [];

  return (
    <section className="chat-workspace">
      <header className="workspace-header">
        <div>
          <span className="eyebrow">Conversation</span>
          <h1>{conversation.data?.title ?? '加载中…'}</h1>
        </div>
        <div className={`run-state ${activeRunId === undefined ? '' : 'active'}`}>
          <span />
          {activeRunId === undefined ? 'Ready' : 'Running'}
        </div>
      </header>
      <div className="message-scroll" ref={scrollRef}>
        {items.length === 0 && streamedContent === '' ? (
          <div className="conversation-welcome">
            <div className="welcome-orbit">
              <Bot size={31} />
            </div>
            <h2>What should we work on?</h2>
            <p>
              运行过程、工具调用和推理与用户可见消息分开保存；上下文过长时会留下可审计的压缩记录。
            </p>
          </div>
        ) : (
          <div className="message-list">
            {items.map((item) => (
              <Message key={item.id} item={item} />
            ))}
            {streamedContent !== '' ? (
              <Message
                item={{
                  id: 'streaming',
                  type: 'assistant',
                  content: streamedContent,
                  reasoning: '',
                  refusal: '',
                  toolCalls: [],
                  scope: 'conversation',
                  visibility: 'user',
                }}
                streaming
              />
            ) : null}
          </div>
        )}
      </div>
      {review !== undefined && activeRunId !== undefined ? (
        <ReviewBanner runId={activeRunId} event={review} />
      ) : null}
      {streamError !== '' ? <div className="stream-warning">{streamError}</div> : null}
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          if (prompt.trim() !== '' && activeRunId === undefined) {
            start.mutate(prompt.trim());
          }
        }}
      >
        <textarea
          value={prompt}
          onChange={(event) => {
            setPrompt(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder="描述任务，Shift + Enter 换行"
          rows={2}
        />
        {activeRunId === undefined ? (
          <button
            className="send-button"
            disabled={start.isPending || prompt.trim() === ''}
            title="发送"
          >
            {start.isPending ? (
              <LoaderCircle className="spin" size={18} />
            ) : (
              <CornerDownLeft size={18} />
            )}
          </button>
        ) : (
          <button
            type="button"
            className="stop-button"
            title="停止"
            onClick={() => void api.cancelRun(activeRunId)}
          >
            <CircleStop size={18} />
          </button>
        )}
      </form>
    </section>
  );
}

function Message(props: {
  readonly item: Exclude<ConversationItem, { type: 'tool-result' }>;
  readonly streaming?: boolean;
}) {
  const assistant = props.item.type === 'assistant';
  return (
    <article className={`message ${assistant ? 'assistant' : 'user'}`}>
      <div className="message-avatar">
        {assistant ? <Bot size={16} /> : <UserRound size={16} />}
      </div>
      <div className="message-body">
        <div className="message-role">{assistant ? 'Dagent' : 'You'}</div>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{props.item.content}</ReactMarkdown>
        {props.streaming ? <span className="typing-caret" /> : null}
      </div>
    </article>
  );
}

function ReviewBanner(props: {
  readonly runId: Parameters<typeof api.review>[0];
  readonly event: Extract<RunEvent, { type: 'review-required' }>;
}) {
  const [resolved, setResolved] = useState(false);
  if (resolved) return null;
  const decide = (action: 'approve' | 'reject') => {
    setResolved(true);
    void api.review(props.runId, {
      reviewId: props.event.review.id,
      revision: props.event.review.revision,
      action,
      reason: '',
    });
  };
  return (
    <div className="review-banner">
      <div>
        <strong>需要确认</strong>
        <span>{props.event.review.summary}</span>
      </div>
      <button
        onClick={() => {
          decide('reject');
        }}
      >
        拒绝
      </button>
      <button
        className="primary"
        onClick={() => {
          decide('approve');
        }}
      >
        批准
      </button>
    </div>
  );
}

function toolAgent(capabilityIds: readonly string[]): RunTarget {
  return {
    kind: 'tool-agent',
    id: 'workspace_assistant',
    name: 'Workspace Assistant',
    description: 'General local workspace assistant.',
    systemPrompt:
      'You are a careful engineering assistant. Use tools only when they materially help, respect the workspace boundary, and explain the completed outcome clearly.',
    scope: { capabilities: [...capabilityIds], skills: [], agents: [] },
    reviewLevel: 'risky',
    context: {
      compactionTriggerRatio: 0.8,
      keepRecentTurns: 4,
      summaryMaxTokens: 1024,
      maxToolResultTokens: 2048,
      maxTotalToolResultTokens: 8192,
      tokenSafetyMargin: 0.15,
    },
    maxSteps: 20,
  };
}
