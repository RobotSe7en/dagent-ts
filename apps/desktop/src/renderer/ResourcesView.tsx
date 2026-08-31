import { useState, type SyntheticEvent } from 'react';
import { Bot, Box, Cable, Check, KeyRound, Plus, RefreshCw, Trash2, Wrench } from 'lucide-react';

import type { DesktopResources } from '../shared/contracts.js';
import { invoke } from './api.js';

type ResourceTab = 'models' | 'mcp' | 'skills' | 'agents';

export function ResourcesView({
  resources,
  onChanged,
  reportError,
}: {
  readonly resources: DesktopResources;
  readonly onChanged: () => Promise<void>;
  readonly reportError: (message: string) => void;
}) {
  const [tab, setTab] = useState<ResourceTab>('models');
  return (
    <section className="page-view resources-view">
      <header className="page-header">
        <div>
          <p className="eyebrow">LOCAL RESOURCES</p>
          <h1>能力资源</h1>
          <p>配置模型、MCP、Skills 与可复用 ToolAgent。桌面端不会显示 DAG 类型的 Agent。</p>
        </div>
        <button
          className="quiet-button"
          onClick={() =>
            void runAction(() => invoke({ action: 'mcp:reload' }), onChanged, reportError)
          }
        >
          <RefreshCw size={15} /> 重载 MCP
        </button>
      </header>
      <nav className="resource-tabs">
        <Tab
          active={tab === 'models'}
          icon={<Box size={16} />}
          label="模型"
          onClick={() => setTab('models')}
        />
        <Tab
          active={tab === 'mcp'}
          icon={<Cable size={16} />}
          label="MCP"
          onClick={() => setTab('mcp')}
        />
        <Tab
          active={tab === 'skills'}
          icon={<Wrench size={16} />}
          label="Skills"
          onClick={() => setTab('skills')}
        />
        <Tab
          active={tab === 'agents'}
          icon={<Bot size={16} />}
          label="ToolAgents"
          onClick={() => setTab('agents')}
        />
      </nav>
      {tab === 'models' && (
        <Models resources={resources} onChanged={onChanged} reportError={reportError} />
      )}
      {tab === 'mcp' && (
        <McpServers resources={resources} onChanged={onChanged} reportError={reportError} />
      )}
      {tab === 'skills' && (
        <Skills resources={resources} onChanged={onChanged} reportError={reportError} />
      )}
      {tab === 'agents' && (
        <Agents resources={resources} onChanged={onChanged} reportError={reportError} />
      )}
    </section>
  );
}

function Models(props: ResourceProps) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    id: '',
    name: '',
    baseURL: 'https://api.openai.com/v1',
    model: '',
    apiKey: '',
    contextWindowTokens: 128000,
    outputReserveTokens: 8192,
  });
  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    await runAction(
      () =>
        invoke({
          action: 'model:create',
          input: {
            ...form,
            apiKey: form.apiKey || undefined,
            apiKeyAction: 'replace',
            timeoutMs: 60000,
            streamIncludeUsage: false,
          },
        }),
      props.onChanged,
      props.reportError,
    );
    setShowForm(false);
  }
  return (
    <div className="resource-content">
      <div className="resource-heading">
        <div>
          <h2>模型供应商</h2>
          <p>兼容 OpenAI Chat Completions 接口。</p>
        </div>
        <button className="primary-small" onClick={() => setShowForm(!showForm)}>
          <Plus size={15} />
          添加模型
        </button>
      </div>
      {showForm && (
        <form className="resource-form" onSubmit={(event) => void submit(event)}>
          <label>
            ID
            <input
              required
              pattern="[A-Za-z][A-Za-z0-9_-]*"
              value={form.id}
              onChange={(event) => setForm({ ...form, id: event.target.value })}
            />
          </label>
          <label>
            显示名称
            <input
              required
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </label>
          <label className="wide">
            Base URL
            <input
              required
              type="url"
              value={form.baseURL}
              onChange={(event) => setForm({ ...form, baseURL: event.target.value })}
            />
          </label>
          <label>
            模型名
            <input
              required
              value={form.model}
              onChange={(event) => setForm({ ...form, model: event.target.value })}
            />
          </label>
          <label>
            API Key
            <input
              type="password"
              autoComplete="off"
              value={form.apiKey}
              onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
            />
          </label>
          <p className="form-note wide">
            <KeyRound size={14} />
            按你的配置选择，密钥会以明文写入仅当前用户可访问的本地 SQLite，不会返回给渲染进程。
          </p>
          <button className="primary-small" type="submit">
            保存
          </button>
        </form>
      )}
      <div className="resource-grid">
        {props.resources.models.models.map((model) => (
          <article className={`resource-card ${model.active ? 'active' : ''}`} key={model.id}>
            <div className="resource-card-title">
              <span className="resource-icon">
                <Box size={18} />
              </span>
              <div>
                <h3>{model.name}</h3>
                <code>{model.model}</code>
              </div>
              {model.active && (
                <span className="active-badge">
                  <Check size={12} />
                  使用中
                </span>
              )}
            </div>
            <p>{model.baseURL}</p>
            <div className="card-actions">
              {!model.active && (
                <button
                  onClick={() =>
                    void runAction(
                      () => invoke({ action: 'model:activate', id: model.id }),
                      props.onChanged,
                      props.reportError,
                    )
                  }
                >
                  启用
                </button>
              )}
              {model.deletable && (
                <button
                  className="danger-link"
                  onClick={() =>
                    void runAction(
                      () => invoke({ action: 'model:delete', id: model.id }),
                      props.onChanged,
                      props.reportError,
                    )
                  }
                >
                  <Trash2 size={14} />
                  删除
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function McpServers(props: ResourceProps) {
  const [showForm, setShowForm] = useState(false);
  const [transport, setTransport] = useState<'stdio' | 'http'>('stdio');
  const [name, setName] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [arguments_, setArguments] = useState('');
  const [secrets, setSecrets] = useState('');
  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const pairs = parsePairs(secrets);
    const config =
      transport === 'stdio'
        ? {
            transport,
            name,
            command: endpoint,
            args: splitArguments(arguments_),
            env: pairs,
            enabled: true,
          }
        : { transport, name, url: endpoint, headers: pairs, enabled: true };
    await runAction(
      () => invoke({ action: 'mcp:create', config }),
      props.onChanged,
      props.reportError,
    );
    setShowForm(false);
  }
  return (
    <div className="resource-content">
      <div className="resource-heading">
        <div>
          <h2>MCP Servers</h2>
          <p>stdio 在本机启动；HTTP 可连接用户指定的远程服务。</p>
        </div>
        <button className="primary-small" onClick={() => setShowForm(!showForm)}>
          <Plus size={15} />
          添加 MCP
        </button>
      </div>
      {showForm && (
        <form className="resource-form" onSubmit={(event) => void submit(event)}>
          <label>
            传输
            <select
              value={transport}
              onChange={(event) => setTransport(event.target.value as 'stdio' | 'http')}
            >
              <option value="stdio">stdio</option>
              <option value="http">HTTP</option>
            </select>
          </label>
          <label>
            名称
            <input
              required
              pattern="[A-Za-z][A-Za-z0-9_-]*"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="wide">
            {transport === 'stdio' ? '命令' : 'URL'}
            <input
              required
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
            />
          </label>
          {transport === 'stdio' && (
            <label className="wide">
              参数（每行一个）
              <textarea value={arguments_} onChange={(event) => setArguments(event.target.value)} />
            </label>
          )}
          <label className="wide">
            {transport === 'stdio' ? '环境变量' : '请求头'}（每行 KEY=VALUE）
            <textarea value={secrets} onChange={(event) => setSecrets(event.target.value)} />
          </label>
          <p className="form-note wide">
            <KeyRound size={14} />
            这些值按你的选择以明文保存在受文件权限保护的本地 SQLite；资源列表只显示键名。
          </p>
          <button className="primary-small" type="submit">
            保存并连接
          </button>
        </form>
      )}
      <div className="resource-grid">
        {props.resources.mcp.servers.map((server) => (
          <article className="resource-card" key={server.name}>
            <div className="resource-card-title">
              <span className="resource-icon">
                <Cable size={18} />
              </span>
              <div>
                <h3>{server.name}</h3>
                <code>{server.config.transport}</code>
              </div>
              <span className={`status-dot ${server.status}`}>{server.status}</span>
            </div>
            <p>
              {server.tools.length} 个工具{server.error === undefined ? '' : ` · ${server.error}`}
            </p>
            <div className="card-actions">
              {server.deletable && (
                <button
                  className="danger-link"
                  onClick={() =>
                    void runAction(
                      () => invoke({ action: 'mcp:delete', name: server.name }),
                      props.onChanged,
                      props.reportError,
                    )
                  }
                >
                  <Trash2 size={14} />
                  删除
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function Skills(props: ResourceProps) {
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    await runAction(
      () => invoke({ action: 'skill:install', name, description, content }),
      props.onChanged,
      props.reportError,
    );
    setShowForm(false);
  }
  return (
    <div className="resource-content">
      <div className="resource-heading">
        <div>
          <h2>Skills</h2>
          <p>按需加载的本地说明与工作流知识。</p>
        </div>
        <button className="primary-small" onClick={() => setShowForm(!showForm)}>
          <Plus size={15} />
          安装 Skill
        </button>
      </div>
      {showForm && (
        <form className="resource-form" onSubmit={(event) => void submit(event)}>
          <label>
            名称
            <input required value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            描述
            <input value={description} onChange={(event) => setDescription(event.target.value)} />
          </label>
          <label className="wide">
            SKILL.md 内容
            <textarea
              className="tall"
              required
              value={content}
              onChange={(event) => setContent(event.target.value)}
            />
          </label>
          <button className="primary-small">安装</button>
        </form>
      )}
      <div className="resource-grid">
        {props.resources.skills.skills.map((skill) => (
          <article className="resource-card" key={skill.qualifiedName}>
            <div className="resource-card-title">
              <span className="resource-icon">
                <Wrench size={18} />
              </span>
              <div>
                <h3>{skill.name}</h3>
                <code>{skill.qualifiedName}</code>
              </div>
            </div>
            <p>{skill.description}</p>
            <div className="card-actions">
              {skill.managed && (
                <button
                  className="danger-link"
                  onClick={() =>
                    void runAction(
                      () => invoke({ action: 'skill:delete', name: skill.qualifiedName }),
                      props.onChanged,
                      props.reportError,
                    )
                  }
                >
                  <Trash2 size={14} />
                  删除
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function Agents(props: ResourceProps) {
  const [showForm, setShowForm] = useState(false);
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const config = {
      kind: 'tool-agent' as const,
      id,
      name,
      description: '',
      systemPrompt: prompt,
      scope: { capabilities: [], skills: [], agents: [] },
      reviewLevel: 'risky' as const,
      maxSteps: 20,
    };
    await runAction(
      () => invoke({ action: 'agent:save', config }),
      props.onChanged,
      props.reportError,
    );
    setShowForm(false);
  }
  return (
    <div className="resource-content">
      <div className="resource-heading">
        <div>
          <h2>ToolAgents</h2>
          <p>可复用的专用代理配置；当前桌面直接任务不会把它们作为可调用工具。</p>
        </div>
        <button className="primary-small" onClick={() => setShowForm(!showForm)}>
          <Plus size={15} />
          新建 ToolAgent
        </button>
      </div>
      {showForm && (
        <form className="resource-form" onSubmit={(event) => void submit(event)}>
          <label>
            ID
            <input
              required
              pattern="[A-Za-z][A-Za-z0-9_-]*"
              value={id}
              onChange={(event) => setId(event.target.value)}
            />
          </label>
          <label>
            名称
            <input required value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="wide">
            系统提示词
            <textarea
              className="tall"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </label>
          <button className="primary-small">保存</button>
        </form>
      )}
      <div className="resource-grid">
        {props.resources.agents.map((stored) => (
          <article className="resource-card" key={stored.config.id}>
            <div className="resource-card-title">
              <span className="resource-icon">
                <Bot size={18} />
              </span>
              <div>
                <h3>{stored.config.name}</h3>
                <code>{stored.config.id}</code>
              </div>
            </div>
            <p>
              {stored.config.description || stored.config.systemPrompt.slice(0, 140) || '无描述'}
            </p>
            <div className="card-actions">
              <button
                className="danger-link"
                onClick={() =>
                  void runAction(
                    () => invoke({ action: 'agent:delete', id: stored.config.id }),
                    props.onChanged,
                    props.reportError,
                  )
                }
              >
                <Trash2 size={14} />
                删除
              </button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

type ResourceProps = {
  readonly resources: DesktopResources;
  readonly onChanged: () => Promise<void>;
  readonly reportError: (message: string) => void;
};

function Tab({
  active,
  icon,
  label,
  onClick,
}: {
  readonly active: boolean;
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly onClick: () => void;
}) {
  return (
    <button className={active ? 'active' : ''} onClick={onClick}>
      {icon}
      {label}
    </button>
  );
}
async function runAction(
  action: () => Promise<unknown>,
  refresh: () => Promise<void>,
  reportError: (message: string) => void,
) {
  try {
    await action();
    await refresh();
  } catch (error) {
    reportError(error instanceof Error ? error.message : '操作失败。');
  }
}
function parsePairs(value: string): Record<string, string> {
  return Object.fromEntries(
    value
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const index = line.indexOf('=');
        return index < 0 ? [line, ''] : [line.slice(0, index), line.slice(index + 1)];
      }),
  );
}
function splitArguments(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}
