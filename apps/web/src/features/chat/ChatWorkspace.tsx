import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RunEvent, RunTarget } from 'dagent-ai';
import {
  Bot,
  CircleStop,
  CornerDownLeft,
  Paperclip,
  LoaderCircle,
  MessageSquareText,
  UserRound,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { api, type PublicConversationItem, subscribeRun } from '../../api/client.js';
import { EmptyState } from '../../components/EmptyState.js';
import { useWorkspace } from '../../state/workspace.js';

export function ChatWorkspace() {
  const queryClient = useQueryClient();
  const { conversationId, activeRunId, beginRun, appendRunEvent, clearRun, runEvents } =
    useWorkspace();
  const [prompt, setPrompt] = useState('');
  const [uploads, setUploads] = useState<readonly File[]>([]);
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
    mutationFn: async (input: { readonly text: string; readonly uploads: readonly File[] }) => {
      if (conversationId === undefined) throw new Error('Select a conversation.');
      const target = toolAgent(
        capabilities.data
          ?.filter((capability) => capability.kind !== 'skill')
          .map((capability) => capability.id) ?? [],
      );
      return api.startRun({
        conversationId,
        target,
        input: {
          prompt: input.text,
          ...(input.uploads.length === 0
            ? {}
            : {
                uploads: await Promise.all(
                  input.uploads.map(async (file) => ({
                    filename: file.name,
                    contentBase64: await fileBase64(file),
                  })),
                ),
              }),
        },
      });
    },
    onSuccess: ({ runId }) => {
      setPrompt('');
      setUploads([]);
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
      (item): item is Exclude<PublicConversationItem, { type: 'tool-result' }> =>
        item.visibility === 'user' && item.type !== 'tool-result',
    ) ?? [];
  const summary = conversation.data?.conversation.summary;

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
        {items.length === 0 && summary === undefined && streamedContent === '' ? (
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
            {summary === undefined ? null : (
              <aside className="conversation-summary">
                <strong>Earlier conversation</strong>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{summary.content}</ReactMarkdown>
              </aside>
            )}
            {items.map((item) => (
              <Message key={item.id} item={item} />
            ))}
            {streamedContent !== '' ? (
              <Message
                item={{
                  id: 'streaming',
                  type: 'assistant',
                  content: streamedContent,
                  refusal: '',
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
            start.mutate({ text: prompt.trim(), uploads });
          }
        }}
      >
        {uploads.length > 0 ? (
          <div className="upload-list">
            {uploads.map((file, index) => (
              <span key={`${file.name}-${file.size}-${index}`}>
                {file.name}
                <button
                  type="button"
                  aria-label={`移除 ${file.name}`}
                  onClick={() => {
                    setUploads((current) => current.filter((_, itemIndex) => itemIndex !== index));
                  }}
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <div className="composer-row">
          <label className="attach-button" title="上传文件">
            <Paperclip size={18} />
            <input
              type="file"
              multiple
              disabled={activeRunId !== undefined}
              onChange={(event) => {
                const selected = [...(event.currentTarget.files ?? [])];
                setUploads((current) => [...current, ...selected].slice(0, 32));
                event.currentTarget.value = '';
              }}
            />
          </label>
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
        </div>
      </form>
    </section>
  );
}

function Message(props: {
  readonly item: Exclude<PublicConversationItem, { type: 'tool-result' }>;
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
        {props.item.type === 'user' && props.item.attachments.length > 0 ? (
          <div className="message-attachments">
            {props.item.attachments.map((attachment) => (
              <span key={attachment.id}>
                <Paperclip size={12} />
                {attachment.path.split('/').at(-1)}
              </span>
            ))}
          </div>
        ) : null}
        {props.streaming ? <span className="typing-caret" /> : null}
      </div>
    </article>
  );
}

function ReviewBanner(props: {
  readonly runId: Parameters<typeof api.review>[0];
  readonly event: Extract<RunEvent, { type: 'review-required' }>;
}) {
  const review = useMutation({
    mutationFn: (action: 'approve' | 'reject') =>
      api.review(props.runId, {
        reviewId: props.event.review.id,
        revision: props.event.review.revision,
        action,
        reason: '',
      }),
  });
  if (review.isSuccess) return null;
  return (
    <div className="review-banner">
      <div>
        <strong>需要确认</strong>
        <span>{props.event.review.summary}</span>
        {review.error instanceof Error ? (
          <span className="review-error">{review.error.message}</span>
        ) : null}
      </div>
      <button
        onClick={() => {
          review.mutate('reject');
        }}
        disabled={review.isPending}
      >
        拒绝
      </button>
      <button
        className="primary"
        onClick={() => {
          review.mutate('approve');
        }}
        disabled={review.isPending}
      >
        批准
      </button>
    </div>
  );
}

async function fileBase64(file: File): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      reject(reader.error ?? new Error(`无法读取文件 ${file.name}`));
    };
    reader.onload = () => {
      const value = reader.result;
      if (typeof value !== 'string') {
        reject(new Error(`无法编码文件 ${file.name}`));
        return;
      }
      resolvePromise(value.slice(value.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
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
