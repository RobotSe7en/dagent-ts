import {
  Activity,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleStop,
  Files,
  Folder,
  FolderGit2,
  FolderOpen,
  GitCompareArrows,
  LoaderCircle,
  MessageSquarePlus,
  Paperclip,
  Play,
  Plus,
  RotateCw,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Wrench,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import type { Conversation, ProjectFileView, StoredRun } from 'dagent-ai-app';
import type { PendingReview, ReviewLevel, RunEvent } from 'dagent-ai/contracts';

import type {
  AttachmentGrant,
  DesktopBootstrap,
  DesktopResources,
  FileChange,
  FolderGrant,
  GitFileStatus,
  RunChanges,
} from '../shared/contracts.js';
import { invoke } from './api.js';
import { BrandMark } from './BrandMark.js';
import { FilePreview } from './FilePreview.js';
import { ResourcesView } from './ResourcesView.js';

type MainView = 'work' | 'runs' | 'resources' | 'settings';
type InspectorTab = 'files' | 'changes' | 'abilities';

export function App() {
  const [data, setData] = useState<DesktopBootstrap>();
  const [view, setView] = useState<MainView>('work');
  const [projectId, setProjectId] = useState<string>();
  const [conversationId, setConversationId] = useState<string>();
  const [runId, setRunId] = useState<string>();
  const [events, setEvents] = useState<Record<string, readonly RunEvent[]>>({});
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('files');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const next = await invoke<DesktopBootstrap>({ action: 'bootstrap' });
    setData(next);
    setLoading(false);
    setProjectId((current) => current ?? next.projects[0]?.id);
  }, []);

  const refreshResources = useCallback(async () => {
    const resources = await invoke<DesktopResources>({ action: 'resources:list' });
    setData((current) => (current === undefined ? current : { ...current, resources }));
  }, []);

  useEffect(() => {
    void refresh().catch((reason: unknown) => {
      setError(errorMessage(reason));
      setLoading(false);
    });
  }, [refresh]);

  useEffect(
    () =>
      window.dagentDesktop.onRunEvent(({ event }) => {
        setEvents((current) => {
          const existing = current[event.runId] ?? [];
          if (existing.some(({ sequence }) => sequence === event.sequence)) return current;
          return {
            ...current,
            [event.runId]: [...existing, event].sort((a, b) => a.sequence - b.sequence),
          };
        });
        if (event.type === 'run-completed') void refresh();
      }),
    [refresh],
  );

  const currentConversation = data?.conversations.find(({ id }) => id === conversationId);
  const projectConversations =
    data?.conversations.filter((conversation) =>
      projectId === undefined
        ? conversation.workspaceScope === 'standalone'
        : conversation.projectId === projectId,
    ) ?? [];
  const selectedRun =
    data?.runs.find(({ id }) => id === runId) ??
    data?.runs.find(({ conversationId: id }) => id === conversationId);

  function selectProject(id: string | undefined) {
    setProjectId(id);
    const first = data?.conversations.find((conversation) =>
      id === undefined
        ? conversation.workspaceScope === 'standalone'
        : conversation.projectId === id,
    );
    setConversationId(first?.id);
    setRunId(
      first === undefined
        ? undefined
        : data?.runs.find((run) => run.conversationId === first.id)?.id,
    );
    setView('work');
  }

  function selectConversation(conversation: Conversation) {
    setConversationId(conversation.id);
    setProjectId(conversation.projectId);
    setRunId(data?.runs.find((run) => run.conversationId === conversation.id)?.id);
    setView('work');
  }

  async function addProject() {
    try {
      const grant = await invoke<FolderGrant | undefined>({ action: 'dialog:folder' });
      if (grant === undefined) return;
      const project = await invoke<{ readonly id: string }>({
        action: 'project:create',
        grantId: grant.grantId,
        name: grant.name,
      });
      await refresh();
      selectProject(project.id);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  if (loading)
    return (
      <div className="startup">
        <BrandMark />
        <LoaderCircle className="spin" />
        <span>正在启动本地运行时…</span>
      </div>
    );
  if (data === undefined)
    return (
      <div className="startup error-state">
        <BrandMark />
        <h2>无法启动 DagentWork</h2>
        <p>{error}</p>
        <button onClick={() => void refresh()}>重试</button>
      </div>
    );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <BrandMark />
          <span>DagentWork</span>
        </div>
        <button
          className="new-task"
          onClick={() => {
            setConversationId(undefined);
            setRunId(undefined);
            setView('work');
          }}
        >
          <MessageSquarePlus size={17} />
          新任务
        </button>
        <nav className="main-nav">
          <button className={view === 'runs' ? 'active' : ''} onClick={() => setView('runs')}>
            <Activity size={16} />
            运行记录
          </button>
          <button
            className={view === 'resources' ? 'active' : ''}
            onClick={() => setView('resources')}
          >
            <Wrench size={16} />
            能力资源
          </button>
        </nav>
        <div className="sidebar-section">
          <div className="section-label">
            <span>项目</span>
            <button aria-label="添加项目" onClick={() => void addProject()}>
              <Plus size={14} />
            </button>
          </div>
          <button
            className={`project-row ${projectId === undefined ? 'active' : ''}`}
            onClick={() => selectProject(undefined)}
          >
            <Sparkles size={15} />
            <span>独立任务</span>
          </button>
          {data.projects.map((project) => (
            <button
              className={`project-row ${project.id === projectId ? 'active' : ''}`}
              key={project.id}
              onClick={() => selectProject(project.id)}
              title={project.rootPath}
            >
              <FolderGit2 size={15} />
              <span>{project.name}</span>
              <ChevronRight size={13} />
            </button>
          ))}
        </div>
        <div className="sidebar-section conversations">
          <div className="section-label">
            <span>最近任务</span>
          </div>
          {projectConversations.map((conversation) => (
            <button
              className={conversation.id === conversationId ? 'active' : ''}
              key={conversation.id}
              onClick={() => selectConversation(conversation)}
            >
              <span className="conversation-dot" />
              <span>{conversation.title}</span>
            </button>
          ))}
          {projectConversations.length === 0 && <p className="sidebar-empty">发送一条消息开始。</p>}
        </div>
        <button
          className={`settings-link ${view === 'settings' ? 'active' : ''}`}
          onClick={() => setView('settings')}
        >
          <Settings size={16} />
          设置 <span>v{data.version}</span>
        </button>
      </aside>
      <main className="main-area">
        {view === 'work' && (
          <Workbench
            data={data}
            projectId={projectId}
            conversation={currentConversation}
            selectedRun={selectedRun}
            liveEvents={runId === undefined ? [] : (events[runId] ?? [])}
            inspectorTab={inspectorTab}
            setInspectorTab={setInspectorTab}
            setConversationId={setConversationId}
            setRunId={setRunId}
            refresh={refresh}
            reportError={setError}
          />
        )}
        {view === 'runs' && (
          <RunsView
            data={data}
            select={(run) => {
              setRunId(run.id);
              const conversation = data.conversations.find(({ id }) => id === run.conversationId);
              if (conversation !== undefined) selectConversation(conversation);
              else setView('work');
            }}
          />
        )}
        {view === 'resources' && (
          <ResourcesView
            resources={data.resources}
            onChanged={refreshResources}
            reportError={setError}
          />
        )}
        {view === 'settings' && <SettingsView version={data.version} />}
      </main>
      {error.length > 0 && (
        <div className="error-toast">
          <span>{error}</span>
          <button onClick={() => setError('')}>
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}

function Workbench({
  data,
  projectId,
  conversation,
  selectedRun,
  liveEvents,
  inspectorTab,
  setInspectorTab,
  setConversationId,
  setRunId,
  refresh,
  reportError,
}: {
  readonly data: DesktopBootstrap;
  readonly projectId: string | undefined;
  readonly conversation: Conversation | undefined;
  readonly selectedRun: StoredRun | undefined;
  readonly liveEvents: readonly RunEvent[];
  readonly inspectorTab: InspectorTab;
  readonly setInspectorTab: (tab: InspectorTab) => void;
  readonly setConversationId: (id: string) => void;
  readonly setRunId: (id: string) => void;
  readonly refresh: () => Promise<void>;
  readonly reportError: (message: string) => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<readonly AttachmentGrant[]>([]);
  const [reviewLevel, setReviewLevel] = useState<ReviewLevel>('risky');
  const [capabilities, setCapabilities] = useState<Set<string>>(new Set());
  const [skills, setSkills] = useState<Set<string>>(new Set());
  const [agents, setAgents] = useState<Set<string>>(new Set());
  const [optimisticPrompt, setOptimisticPrompt] = useState('');
  const project = data.projects.find(({ id }) => id === projectId);

  useEffect(() => {
    setCapabilities((current) =>
      current.size > 0
        ? current
        : new Set(data.resources.capabilities.filter(({ enabled }) => enabled).map(({ id }) => id)),
    );
  }, [data.resources.capabilities]);

  async function attach() {
    try {
      setAttachments(await invoke<readonly AttachmentGrant[]>({ action: 'dialog:attachments' }));
    } catch (reason) {
      reportError(errorMessage(reason));
    }
  }
  async function send() {
    if (prompt.trim().length === 0 || sending) return;
    setSending(true);
    const content = prompt.trim();
    setOptimisticPrompt(content);
    setPrompt('');
    try {
      let id = conversation?.id;
      if (id === undefined) {
        const created = await invoke<Conversation>({
          action: 'conversation:create',
          ...(projectId === undefined ? {} : { projectId }),
          title: content.slice(0, 80),
        });
        id = created.id;
        setConversationId(id);
      }
      const started = await invoke<{ readonly runId: string }>({
        action: 'run:start',
        conversationId: id,
        prompt: content,
        capabilityIds: [...capabilities],
        skillIds: [...skills],
        agentIds: [...agents],
        attachmentGrantIds: attachments.map(({ grantId }) => grantId),
        reviewLevel,
      });
      setRunId(started.runId);
      setAttachments([]);
      await refresh();
    } catch (reason) {
      setPrompt(content);
      reportError(errorMessage(reason));
    } finally {
      setSending(false);
      setOptimisticPrompt('');
    }
  }
  const pendingReview = latestReview(liveEvents) ?? selectedRun?.checkpoint?.state.pendingReview;
  const timelineItems =
    conversation?.conversation?.items.filter((item) => item.visibility === 'user') ?? [];
  const tokenEvents = liveEvents.filter(
    (event): event is Extract<RunEvent, { readonly type: 'token' }> => event.type === 'token',
  );
  const liveContent = tokenEvents
    .filter((event) => event.channel === 'content')
    .map((event) => event.content)
    .join('');
  const liveReasoning = tokenEvents
    .filter((event) => event.channel === 'reasoning')
    .map((event) => event.content)
    .join('');
  const active =
    (liveEvents.length > 0 && !liveEvents.some((event) => event.type === 'run-completed')) ||
    ['pending', 'planning', 'running', 'resuming'].includes(selectedRun?.status ?? '');
  return (
    <div className="workbench">
      <section className="conversation-pane">
        <header className="work-header">
          <div>
            <span className="workspace-label">
              {project === undefined ? '独立任务' : project.name}
            </span>
            <h1>{conversation?.title ?? '新任务'}</h1>
          </div>
          {project !== undefined && (
            <span className="path-pill" title={project.rootPath}>
              <FolderOpen size={13} />
              {project.rootPath}
            </span>
          )}
        </header>
        <div className="timeline">
          {timelineItems.length === 0 && optimisticPrompt.length === 0 && (
            <Welcome projectName={project?.name} />
          )}
          {timelineItems.map((item) =>
            item.type === 'user' ? (
              <div className="message user-message" key={item.id}>
                <div className="message-label">你</div>
                <p>{item.content}</p>
              </div>
            ) : item.type === 'assistant' ? (
              <div className="message assistant-message" key={item.id}>
                <div className="assistant-avatar">
                  <BrandMark />
                </div>
                <div className="message-body">
                  <div className="message-label">DagentWork</div>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {item.content || item.refusal}
                  </ReactMarkdown>
                </div>
              </div>
            ) : null,
          )}
          {optimisticPrompt.length > 0 && (
            <div className="message user-message pending">
              <div className="message-label">你</div>
              <p>{optimisticPrompt}</p>
            </div>
          )}
          {(active || liveContent.length > 0 || liveReasoning.length > 0) && (
            <AssistantProcess events={liveEvents} content={liveContent} reasoning={liveReasoning} />
          )}
          {pendingReview !== undefined && (
            <ReviewCard
              runId={selectedRun?.id}
              review={pendingReview}
              onDone={refresh}
              reportError={reportError}
            />
          )}
        </div>
        <div className="composer-wrap">
          <div className="composer">
            {attachments.length > 0 && (
              <div className="attachment-row">
                {attachments.map((file) => (
                  <span key={file.grantId}>
                    <Paperclip size={12} />
                    {file.name}
                    <button
                      onClick={() =>
                        setAttachments(
                          attachments.filter(({ grantId }) => grantId !== file.grantId),
                        )
                      }
                    >
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <textarea
              aria-label="任务说明"
              placeholder={
                project === undefined
                  ? '询问或完成一个独立任务…'
                  : '描述你希望在当前项目中完成的工作…'
              }
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            <div className="composer-tools">
              <div>
                <button title="添加附件" onClick={() => void attach()}>
                  <Paperclip size={17} />
                </button>
                <select
                  value={reviewLevel}
                  onChange={(event) => setReviewLevel(event.target.value as ReviewLevel)}
                >
                  <option value="risky">风险操作时审核</option>
                  <option value="always">每次工具调用审核</option>
                  <option value="never">不审核</option>
                </select>
              </div>
              {active ? (
                <button
                  className="stop-button"
                  onClick={() =>
                    selectedRun && void invoke({ action: 'run:cancel', runId: selectedRun.id })
                  }
                >
                  <CircleStop size={17} />
                </button>
              ) : (
                <button
                  className="send-button"
                  disabled={sending || prompt.trim().length === 0}
                  onClick={() => void send()}
                >
                  {sending ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />}
                </button>
              )}
            </div>
          </div>
        </div>
      </section>
      <aside className="inspector">
        <nav>
          <button
            className={inspectorTab === 'files' ? 'active' : ''}
            onClick={() => setInspectorTab('files')}
          >
            <Files size={15} />
            文件
          </button>
          <button
            className={inspectorTab === 'changes' ? 'active' : ''}
            onClick={() => setInspectorTab('changes')}
          >
            <GitCompareArrows size={15} />
            变化
          </button>
          <button
            className={inspectorTab === 'abilities' ? 'active' : ''}
            onClick={() => setInspectorTab('abilities')}
          >
            <Sparkles size={15} />
            能力
          </button>
        </nav>
        {inspectorTab === 'files' &&
          (projectId === undefined ? (
            <InspectorEmpty
              icon={<Folder size={25} />}
              title="未选择项目"
              text="独立任务使用隔离的托管工作目录。"
            />
          ) : (
            <FileBrowser projectId={projectId} reportError={reportError} />
          ))}
        {inspectorTab === 'changes' &&
          (selectedRun === undefined ? (
            <InspectorEmpty
              icon={<GitCompareArrows size={25} />}
              title="尚无运行"
              text="运行结束后在这里查看实际发生的文件变化。"
            />
          ) : (
            <ChangesView run={selectedRun} projectId={projectId} reportError={reportError} />
          ))}
        {inspectorTab === 'abilities' && (
          <Abilities
            resources={data.resources}
            capabilities={capabilities}
            skills={skills}
            agents={agents}
            setCapabilities={setCapabilities}
            setSkills={setSkills}
            setAgents={setAgents}
          />
        )}
      </aside>
    </div>
  );
}

function Welcome({ projectName }: { readonly projectName: string | undefined }) {
  return (
    <div className="welcome">
      <BrandMark />
      <p className="eyebrow">DAGENT AI · LOCAL FIRST</p>
      <h2>{projectName === undefined ? '今天想完成什么？' : `在 ${projectName} 中开始工作`}</h2>
      <p>
        {projectName === undefined
          ? '无需项目也能开始；文件会写入隔离的本地工作区。'
          : 'DagentWork 会直接操作该目录，并在运行后展示观察到的差异。'}
      </p>
      <div className="suggestions">
        <span>解释代码结构</span>
        <span>实现并验证功能</span>
        <span>整理文档与数据</span>
      </div>
    </div>
  );
}

function AssistantProcess({
  events,
  content,
  reasoning,
}: {
  readonly events: readonly RunEvent[];
  readonly content: string;
  readonly reasoning: string;
}) {
  const calls = events.filter((event) => event.type === 'capability-started');
  return (
    <div className="message assistant-message live">
      <div className="assistant-avatar">
        <BrandMark />
      </div>
      <div className="message-body">
        <div className="message-label">
          <span className="pulse" />
          DagentWork 正在工作
        </div>
        {reasoning && (
          <details>
            <summary>查看思考过程</summary>
            <pre>{reasoning}</pre>
          </details>
        )}
        {calls.length > 0 && (
          <div className="process-list">
            {calls.map((event) => (
              <div key={event.sequence}>
                <Wrench size={13} />
                <code>{event.invocation.capabilityId}</code>
                <span>
                  {events.some(
                    (item) =>
                      item.type === 'capability-completed' &&
                      item.result.invocationId === event.invocation.id,
                  )
                    ? '完成'
                    : '运行中'}
                </span>
              </div>
            ))}
          </div>
        )}
        {content && <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>}
      </div>
    </div>
  );
}

function ReviewCard({
  runId,
  review,
  onDone,
  reportError,
}: {
  readonly runId: string | undefined;
  readonly review: PendingReview;
  readonly onDone: () => Promise<void>;
  readonly reportError: (message: string) => void;
}) {
  if (runId === undefined) return null;
  const requiredRunId = runId;
  async function decide(action: 'approve' | 'reject') {
    try {
      await invoke({
        action: 'run:review',
        runId: requiredRunId,
        decision: { reviewId: review.id, revision: review.revision, action, reason: '' },
      });
      await onDone();
    } catch (reason) {
      reportError(errorMessage(reason));
    }
  }
  return (
    <div className="review-card">
      <div>
        <ShieldCheck size={18} />
        <strong>需要你的确认</strong>
      </div>
      <p>{review.summary}</p>
      {review.invocation && <code>{review.invocation.capabilityId}</code>}
      <div>
        <button className="reject" onClick={() => void decide('reject')}>
          拒绝
        </button>
        <button className="approve" onClick={() => void decide('approve')}>
          批准并继续
        </button>
      </div>
    </div>
  );
}

function FileBrowser({
  projectId,
  reportError,
}: {
  readonly projectId: string;
  readonly reportError: (message: string) => void;
}) {
  const [path, setPath] = useState('.');
  const [file, setFile] = useState<ProjectFileView>();
  const [history, setHistory] = useState<string[]>([]);
  const [refreshVersion, setRefreshVersion] = useState(0);
  useEffect(() => {
    void invoke<ProjectFileView>({ action: 'file:inspect', projectId, path })
      .then(setFile)
      .catch((reason: unknown) => reportError(errorMessage(reason)));
  }, [path, projectId, refreshVersion, reportError]);
  function open(next: string) {
    setHistory([...history, path]);
    setPath(next);
  }
  return (
    <div className="file-browser">
      <div className="browser-toolbar">
        <button
          disabled={history.length === 0}
          onClick={() => {
            const previous = history.at(-1);
            if (previous !== undefined) {
              setPath(previous);
              setHistory(history.slice(0, -1));
            }
          }}
        >
          <ChevronLeft size={15} />
        </button>
        <span>{path}</span>
        <button title="刷新文件" onClick={() => setRefreshVersion((value) => value + 1)}>
          <RotateCw size={14} />
        </button>
      </div>
      {file?.type === 'directory' ? (
        <div className="file-list">
          {file.entries.map((entry) => (
            <button key={entry.path} onClick={() => open(entry.path)}>
              {entry.type === 'directory' ? <Folder size={15} /> : <Files size={15} />}
              <span>{entry.name}</span>
              <small>{entry.type === 'file' ? formatBytes(entry.size) : ''}</small>
            </button>
          ))}
        </div>
      ) : file?.type === 'file' ? (
        <div className="preview-wrap">
          <button
            className="back-to-files"
            onClick={() => {
              const parts = file.path.split('/');
              parts.pop();
              setPath(parts.join('/') || '.');
            }}
          >
            <ChevronLeft size={14} />
            返回
          </button>
          <h3>{file.name}</h3>
          <div className="file-preview">
            <FilePreview projectId={projectId} file={file} />
          </div>
        </div>
      ) : (
        <InspectorEmpty icon={<LoaderCircle className="spin" size={24} />} title="读取中" text="" />
      )}
    </div>
  );
}

function ChangesView({
  run,
  projectId,
  reportError,
}: {
  readonly run: StoredRun;
  readonly projectId: string | undefined;
  readonly reportError: (message: string) => void;
}) {
  const [changes, setChanges] = useState<RunChanges>();
  const [git, setGit] = useState<readonly GitFileStatus[]>([]);
  const [selected, setSelected] = useState<FileChange>();
  const [refreshVersion, setRefreshVersion] = useState(0);
  useEffect(() => {
    void invoke<RunChanges>({ action: 'changes:get', runId: run.id })
      .then(setChanges)
      .catch((reason: unknown) => reportError(errorMessage(reason)));
    if (projectId !== undefined)
      void invoke<readonly GitFileStatus[]>({ action: 'git:status', projectId })
        .then(setGit)
        .catch(() => setGit([]));
  }, [projectId, refreshVersion, reportError, run.id, run.updatedAt]);
  if (changes === undefined)
    return (
      <InspectorEmpty icon={<LoaderCircle className="spin" size={24} />} title="读取变化" text="" />
    );
  return (
    <div className="changes-view">
      <div className="changes-summary">
        <strong>{changes.files.length}</strong>
        <span>个运行变化</span>
        {changes.truncated && <em>扫描已截断</em>}
        <button title="刷新变化" onClick={() => setRefreshVersion((value) => value + 1)}>
          <RotateCw size={13} />
        </button>
      </div>
      {changes.files.length === 0 && (
        <p className="empty-copy">未观察到文件变化，或运行尚未结束。</p>
      )}
      {changes.files.map((change) => (
        <button
          className={selected?.path === change.path ? 'active' : ''}
          key={change.path}
          onClick={() => setSelected(change)}
        >
          <span className={`change-kind ${change.status}`}>{change.status[0]?.toUpperCase()}</span>
          <span>{change.path}</span>
        </button>
      ))}
      {selected?.diff && <pre className="diff-preview">{selected.diff}</pre>}
      {git.length > 0 && (
        <>
          <h4>当前 Git 工作区</h4>
          {git.map((entry) => (
            <div className="git-row" key={entry.path}>
              <code>
                {entry.index}
                {entry.workingTree}
              </code>
              <span>{entry.path}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function Abilities({
  resources,
  capabilities,
  skills,
  agents,
  setCapabilities,
  setSkills,
  setAgents,
}: {
  readonly resources: DesktopResources;
  readonly capabilities: Set<string>;
  readonly skills: Set<string>;
  readonly agents: Set<string>;
  readonly setCapabilities: (value: Set<string>) => void;
  readonly setSkills: (value: Set<string>) => void;
  readonly setAgents: (value: Set<string>) => void;
}) {
  return (
    <div className="abilities">
      <p>仅勾选的能力会进入本次 ToolAgent 上下文。</p>
      <AbilityGroup
        title="工具"
        items={resources.capabilities.map((item) => ({
          id: item.id,
          label: item.name,
          detail: item.risk,
        }))}
        selected={capabilities}
        setSelected={setCapabilities}
      />
      <AbilityGroup
        title="Skills"
        items={resources.skills.skills.map((item) => ({
          id: item.qualifiedName,
          label: item.name,
          detail: item.description,
        }))}
        selected={skills}
        setSelected={setSkills}
      />
      <AbilityGroup
        title="ToolAgents"
        items={resources.agents.map((item) => ({
          id: item.config.id,
          label: item.config.name,
          detail: item.config.description,
        }))}
        selected={agents}
        setSelected={setAgents}
      />
    </div>
  );
}
function AbilityGroup({
  title,
  items,
  selected,
  setSelected,
}: {
  readonly title: string;
  readonly items: readonly {
    readonly id: string;
    readonly label: string;
    readonly detail: string;
  }[];
  readonly selected: Set<string>;
  readonly setSelected: (value: Set<string>) => void;
}) {
  return (
    <section>
      <h3>
        {title}
        <span>{items.length}</span>
      </h3>
      {items.map((item) => (
        <label key={item.id}>
          <input
            type="checkbox"
            checked={selected.has(item.id)}
            onChange={() => {
              const next = new Set(selected);
              if (next.has(item.id)) next.delete(item.id);
              else next.add(item.id);
              setSelected(next);
            }}
          />
          <span>
            <strong>{item.label}</strong>
            <small>
              {item.id} · {item.detail}
            </small>
          </span>
        </label>
      ))}
    </section>
  );
}

function RunsView({
  data,
  select,
}: {
  readonly data: DesktopBootstrap;
  readonly select: (run: StoredRun) => void;
}) {
  return (
    <section className="page-view">
      <header className="page-header">
        <div>
          <p className="eyebrow">LOCAL EXECUTIONS</p>
          <h1>运行记录</h1>
          <p>所有执行、事件与审核点都保存在本机。</p>
        </div>
      </header>
      <div className="runs-table">
        {data.runs.map((run) => (
          <button key={run.id} onClick={() => select(run)}>
            <span className={`run-status ${run.status}`}>
              {run.status === 'completed' ? <CheckCircle2 size={16} /> : <Play size={16} />}
            </span>
            <span>
              <strong>
                {data.conversations.find(({ id }) => id === run.conversationId)?.title ??
                  '独立运行'}
              </strong>
              <code>{run.id}</code>
            </span>
            <time>{formatDate(run.updatedAt)}</time>
            <ChevronRight size={15} />
          </button>
        ))}
      </div>
    </section>
  );
}
function SettingsView({ version }: { readonly version: string }) {
  return (
    <section className="page-view settings-view">
      <header className="page-header">
        <div>
          <p className="eyebrow">DESKTOP</p>
          <h1>设置</h1>
          <p>DagentWork 开源本地桌面端。</p>
        </div>
      </header>
      <div className="settings-card">
        <BrandMark />
        <div>
          <h2>DagentWork {version}</h2>
          <p>本地 SQLite · 本地 ToolAgent 运行时 · 项目目录直接编辑</p>
        </div>
      </div>
      <div className="settings-card">
        <ShieldCheck />
        <div>
          <h3>安全边界</h3>
          <p>
            渲染进程启用 sandbox 和 contextIsolation，无 Node.js 权限；文件、Shell、MCP stdio
            与数据库只在主进程中运行。远程访问仅发生于你配置的模型 HTTP 与 HTTP MCP。
          </p>
        </div>
      </div>
      <div className="settings-card">
        <GitCompareArrows />
        <div>
          <h3>变化策略</h3>
          <p>
            运行前后差异只用于观察与展示。桌面端不提供 Apply、下载变更集、回滚或企业工作区交换功能。
          </p>
        </div>
      </div>
    </section>
  );
}
function InspectorEmpty({
  icon,
  title,
  text,
}: {
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly text: string;
}) {
  return (
    <div className="inspector-empty">
      {icon}
      <strong>{title}</strong>
      <p>{text}</p>
    </div>
  );
}
function latestReview(events: readonly RunEvent[]) {
  return [...events].reverse().find((event) => event.type === 'review-required')?.review;
}
function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}
function errorMessage(value: unknown) {
  return value instanceof Error ? value.message : '操作失败。';
}
