import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BookOpen,
  Bot,
  Boxes,
  Cable,
  Check,
  CircleAlert,
  Cpu,
  FileText,
  Gauge,
  Power,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { api } from '../../api/client.js';

type SettingsTab =
  'capabilities' | 'models' | 'agents' | 'modules' | 'skills' | 'profiles' | 'mcp' | 'runtime';

const tabs: readonly {
  readonly id: SettingsTab;
  readonly label: string;
  readonly icon: ReactNode;
}[] = [
  { id: 'capabilities', label: 'Capabilities', icon: <ShieldCheck size={15} /> },
  { id: 'models', label: 'Models', icon: <Cpu size={15} /> },
  { id: 'agents', label: 'Agents', icon: <Bot size={15} /> },
  { id: 'modules', label: 'Modules', icon: <Boxes size={15} /> },
  { id: 'skills', label: 'Skills', icon: <BookOpen size={15} /> },
  { id: 'profiles', label: 'Profiles', icon: <FileText size={15} /> },
  { id: 'mcp', label: 'MCP', icon: <Cable size={15} /> },
  { id: 'runtime', label: 'Runtime', icon: <Gauge size={15} /> },
];

export function SettingsDrawer(props: { readonly onClose: () => void }) {
  const [tab, setTab] = useState<SettingsTab>('capabilities');
  return (
    <div className="settings-backdrop" role="presentation" onMouseDown={props.onClose}>
      <aside
        className="settings-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Runtime settings"
        onMouseDown={(event) => {
          event.stopPropagation();
        }}
      >
        <header>
          <div>
            <span className="eyebrow">Local runtime</span>
            <h2>Settings</h2>
          </div>
          <button className="icon-button" onClick={props.onClose}>
            <X size={16} />
          </button>
        </header>
        <nav>
          {tabs.map((entry) => (
            <SettingsTabButton
              key={entry.id}
              active={tab === entry.id}
              icon={entry.icon}
              label={entry.label}
              onClick={() => {
                setTab(entry.id);
              }}
            />
          ))}
        </nav>
        <div className="settings-content">
          {tab === 'capabilities' ? <CapabilitiesSettings /> : null}
          {tab === 'models' ? <ModelsSettings /> : null}
          {tab === 'agents' ? <AgentsSettings /> : null}
          {tab === 'modules' ? <ModulesSettings /> : null}
          {tab === 'skills' ? <SkillsSettings /> : null}
          {tab === 'profiles' ? <ProfilesSettings /> : null}
          {tab === 'mcp' ? <McpSettings /> : null}
          {tab === 'runtime' ? <RuntimeSettings /> : null}
        </div>
      </aside>
    </div>
  );
}

function SettingsTabButton(props: {
  readonly active: boolean;
  readonly icon: ReactNode;
  readonly label: string;
  readonly onClick: () => void;
}) {
  return (
    <button className={props.active ? 'active' : ''} onClick={props.onClick}>
      {props.icon}
      {props.label}
    </button>
  );
}

function CapabilitiesSettings() {
  const queryClient = useQueryClient();
  const capabilities = useQuery({
    queryKey: ['capabilities'],
    queryFn: api.capabilities,
  });
  const toggle = useMutation({
    mutationFn: (input: { readonly id: string; readonly enabled: boolean }) =>
      api.setCapabilityEnabled(input.id, input.enabled),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['capabilities'] });
    },
  });
  return (
    <SettingsSection
      title="Capability catalog"
      description="停用后，新运行无法选择或调用该能力。被 Agent 引用的能力不能直接停用。"
    >
      <div className="management-list">
        {capabilities.data?.map((capability) => (
          <div className="management-row" key={capability.id}>
            <div>
              <strong>{capability.name}</strong>
              <span>{capability.id}</span>
            </div>
            <span className={`risk-badge risk-${capability.risk}`}>{capability.risk}</span>
            <button
              className={`toggle ${capability.enabled ? 'on' : ''}`}
              aria-label={`${capability.enabled ? 'Disable' : 'Enable'} ${capability.name}`}
              onClick={() => {
                toggle.mutate({ id: capability.id, enabled: !capability.enabled });
              }}
            >
              <span />
            </button>
          </div>
        ))}
      </div>
    </SettingsSection>
  );
}

function ModelsSettings() {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const models = useQuery({ queryKey: ['models'], queryFn: api.models });
  const activate = useMutation({
    mutationFn: api.activateModel,
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ['models'] }),
  });
  const create = useMutation({
    mutationFn: api.createModel,
    onSuccess: async () => {
      setShowForm(false);
      await queryClient.invalidateQueries({ queryKey: ['models'] });
    },
  });
  const remove = useMutation({
    mutationFn: api.deleteModel,
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ['models'] }),
  });
  return (
    <SettingsSection
      title="Model providers"
      description="模型配置持久化在本地；API 密钥不会从服务端回显。"
      action={<ToggleFormButton open={showForm} setOpen={setShowForm} label="添加" />}
    >
      {showForm ? (
        <JsonCreateForm
          initial={{
            id: 'local_model',
            name: 'Local model',
            baseURL: 'http://127.0.0.1:8000/v1',
            model: 'model-name',
            apiKeyAction: 'preserve',
            timeoutMs: 60_000,
            contextWindowTokens: 128_000,
            outputReserveTokens: 8192,
            streamIncludeUsage: false,
            extraRequestArgs: {},
            extraBody: {},
          }}
          submitLabel="保存模型"
          busy={create.isPending}
          error={create.error}
          onSubmit={create.mutate}
        />
      ) : null}
      <div className="management-list">
        {models.data?.models.map((model) => (
          <div className="management-row" key={model.id}>
            <div>
              <strong>{model.name}</strong>
              <span>
                {model.model} · {model.baseURL}
              </span>
            </div>
            <button
              className={`toggle ${model.active ? 'on' : ''}`}
              aria-label={`Activate ${model.name}`}
              disabled={model.active || activate.isPending}
              onClick={() => {
                activate.mutate(model.id);
              }}
            >
              <span />
            </button>
            {model.deletable ? (
              <DeleteButton label="删除模型" onClick={() => remove.mutate(model.id)} />
            ) : null}
          </div>
        ))}
      </div>
    </SettingsSection>
  );
}

function AgentsSettings() {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const agents = useQuery({ queryKey: ['agents'], queryFn: api.agents });
  const create = useMutation({
    mutationFn: api.createAgent,
    onSuccess: async () => {
      setShowForm(false);
      await queryClient.invalidateQueries({ queryKey: ['agents'] });
    },
  });
  const remove = useMutation({
    mutationFn: api.deleteAgent,
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ['agents'] }),
  });
  return (
    <SettingsSection
      title="Agent presets"
      description="Agent 只引用稳定的 capability 与 skill 标识，运行时验证所有作用域。"
      action={<ToggleFormButton open={showForm} setOpen={setShowForm} label="新建" />}
    >
      {showForm ? (
        <JsonCreateForm
          initial={{
            kind: 'tool-agent',
            id: 'assistant',
            name: 'Assistant',
            description: '',
            systemPrompt: 'Help the user carefully.',
            scope: { capabilities: [], skills: [], agents: [] },
            reviewLevel: 'risky',
            maxSteps: 20,
          }}
          submitLabel="保存 Agent"
          busy={create.isPending}
          error={create.error}
          onSubmit={(value) => {
            create.mutate(value as Parameters<typeof api.createAgent>[0]);
          }}
        />
      ) : null}
      <div className="management-list">
        {agents.data?.map((agent) => (
          <div className="management-row" key={agent.config.id}>
            <div>
              <strong>{agent.config.name}</strong>
              <span>
                {agent.config.id} · {agent.config.kind}
              </span>
            </div>
            <DeleteButton label="删除 Agent" onClick={() => remove.mutate(agent.config.id)} />
          </div>
        ))}
      </div>
    </SettingsSection>
  );
}

function ModulesSettings() {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const modules = useQuery({ queryKey: ['modules'], queryFn: api.capabilityModules });
  const create = useMutation({
    mutationFn: api.createCapabilityModule,
    onSuccess: async () => {
      setShowForm(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['modules'] }),
        queryClient.invalidateQueries({ queryKey: ['capabilities'] }),
      ]);
    },
  });
  const remove = useMutation({
    mutationFn: api.deleteCapabilityModule,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['modules'] }),
        queryClient.invalidateQueries({ queryKey: ['capabilities'] }),
      ]);
    },
  });
  return (
    <SettingsSection
      title="TypeScript capability modules"
      description="模块导出类型化 capability binding 或声明式模块定义，并通过统一目录注册。"
      action={<ToggleFormButton open={showForm} setOpen={setShowForm} label="添加路径" />}
    >
      {showForm ? (
        <JsonCreateForm
          initial={{
            id: 'workspace_tools',
            source: 'path',
            path: '/absolute/path/to/tools.ts',
            exports: ['default'],
            enabled: true,
          }}
          submitLabel="加载模块"
          busy={create.isPending}
          error={create.error}
          onSubmit={create.mutate}
        />
      ) : null}
      <div className="management-list">
        {modules.data?.map((module) => (
          <div className="management-row" key={module.id}>
            <div>
              <strong>{module.id}</strong>
              <span>
                {module.status} · {module.capabilities.length} capabilities
              </span>
            </div>
            {module.deletable ? (
              <DeleteButton label="删除模块" onClick={() => remove.mutate(module.id)} />
            ) : null}
          </div>
        ))}
      </div>
    </SettingsSection>
  );
}

function SkillsSettings() {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const skills = useQuery({ queryKey: ['skills'], queryFn: api.skills });
  const install = useMutation({
    mutationFn: api.installSkill,
    onSuccess: async () => {
      setName('');
      setDescription('');
      setContent('');
      setShowForm(false);
      await queryClient.invalidateQueries({ queryKey: ['skills'] });
    },
  });
  const remove = useMutation({
    mutationFn: api.deleteSkill,
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ['skills'] }),
  });
  return (
    <SettingsSection
      title="Instructional skills"
      description="Skills 是渐进式读取的说明资源，不会直接执行。"
      action={<ToggleFormButton open={showForm} setOpen={setShowForm} label="安装" />}
    >
      {showForm ? (
        <form
          className="settings-form"
          onSubmit={(event) => {
            event.preventDefault();
            install.mutate({
              content,
              ...(name === '' ? {} : { name }),
              ...(description === '' ? {} : { description }),
            });
          }}
        >
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="skill-name"
          />
          <input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="简短说明"
          />
          <textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder="SKILL.md 正文"
            required
          />
          <button className="primary" disabled={install.isPending}>
            安装 Skill
          </button>
        </form>
      ) : null}
      <div className="management-list">
        {skills.data?.map((skill) => (
          <div className="management-row skill-row" key={skill.qualifiedName}>
            <div>
              <strong>{skill.qualifiedName}</strong>
              <span>{skill.description || 'No description'}</span>
            </div>
            {skill.managed ? (
              <>
                <span className="managed-badge">
                  <Check size={11} />
                  managed
                </span>
                <DeleteButton
                  label="删除 Skill"
                  onClick={() => remove.mutate(skill.qualifiedName)}
                />
              </>
            ) : null}
          </div>
        ))}
      </div>
    </SettingsSection>
  );
}

function ProfilesSettings() {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: api.profiles });
  const create = useMutation({
    mutationFn: api.createProfile,
    onSuccess: async () => {
      setName('');
      setContent('');
      setShowForm(false);
      await queryClient.invalidateQueries({ queryKey: ['profiles'] });
    },
  });
  const remove = useMutation({
    mutationFn: api.deleteProfile,
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ['profiles'] }),
  });
  return (
    <SettingsSection
      title="Agent profiles"
      description="Profile 是可复用的系统行为说明；内置与配置来源保持只读。"
      action={<ToggleFormButton open={showForm} setOpen={setShowForm} label="新建" />}
    >
      {showForm ? (
        <form
          className="settings-form"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate({ name, content });
          }}
        >
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="profile-name"
            required
          />
          <textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder="# Profile"
            required
          />
          <button className="primary" disabled={create.isPending}>
            保存 Profile
          </button>
        </form>
      ) : null}
      <div className="management-list">
        {profiles.data?.profiles.map((profile) => (
          <div className="management-row" key={profile.id}>
            <div>
              <strong>{profile.name}</strong>
              <span>
                {profile.source} · {profile.description || 'No description'}
              </span>
            </div>
            {profile.deletable ? (
              <DeleteButton label="删除 Profile" onClick={() => remove.mutate(profile.name)} />
            ) : null}
          </div>
        ))}
      </div>
    </SettingsSection>
  );
}

function McpSettings() {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const servers = useQuery({ queryKey: ['mcp'], queryFn: api.mcpServers });
  const connect = useMutation({
    mutationFn: api.connectMcp,
    onSuccess: async () => {
      setShowForm(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['mcp'] }),
        queryClient.invalidateQueries({ queryKey: ['capabilities'] }),
      ]);
    },
  });
  const disconnect = useMutation({
    mutationFn: api.disconnectMcp,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['mcp'] }),
        queryClient.invalidateQueries({ queryKey: ['capabilities'] }),
      ]);
    },
  });
  return (
    <SettingsSection
      title="MCP servers"
      description="连接信息只返回非敏感状态；headers 和环境变量不会回显。"
      action={<ToggleFormButton open={showForm} setOpen={setShowForm} label="连接" />}
    >
      {showForm ? (
        <JsonCreateForm
          initial={{
            name: 'local_mcp',
            transport: 'stdio',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-everything'],
            risk: 'medium',
          }}
          submitLabel="连接 MCP"
          busy={connect.isPending}
          error={connect.error}
          onSubmit={connect.mutate}
        />
      ) : null}
      <div className="management-list">
        {servers.data?.map((server) => (
          <div className="management-row mcp-row" key={server.name}>
            <Power size={15} />
            <div>
              <strong>{server.name}</strong>
              <span>
                {server.config.transport} · {server.status} · {server.tools.length} capabilities
              </span>
            </div>
            {server.deletable ? (
              <DeleteButton label="断开 MCP" onClick={() => disconnect.mutate(server.name)} />
            ) : null}
          </div>
        ))}
      </div>
    </SettingsSection>
  );
}

function RuntimeSettings() {
  const queryClient = useQueryClient();
  const [showOnlyOfficeForm, setShowOnlyOfficeForm] = useState(false);
  const validation = useQuery({
    queryKey: ['validation-settings'],
    queryFn: api.validationSettings,
  });
  const sandbox = useQuery({ queryKey: ['sandbox-status'], queryFn: api.sandboxStatus });
  const onlyOffice = useQuery({
    queryKey: ['onlyoffice-settings'],
    queryFn: api.onlyOfficeSettings,
  });
  const toggle = useMutation({
    mutationFn: api.setValidationEnabled,
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ['validation-settings'] }),
  });
  const updateOnlyOffice = useMutation({
    mutationFn: api.updateOnlyOffice,
    onSuccess: async () => {
      setShowOnlyOfficeForm(false);
      await queryClient.invalidateQueries({ queryKey: ['onlyoffice-settings'] });
    },
  });
  return (
    <SettingsSection
      title="Runtime policy"
      description="运行时策略由服务端统一执行，浏览器不能绕过验证或沙箱边界。"
    >
      <div className="management-list">
        <div className="management-row">
          <div>
            <strong>Output validation</strong>
            <span>
              {validation.data?.profile ?? 'No profile'} · {validation.data?.maxRetries ?? 0}{' '}
              retries
            </span>
          </div>
          <button
            className={`toggle ${validation.data?.enabled === true ? 'on' : ''}`}
            aria-label="Toggle output validation"
            onClick={() => toggle.mutate(validation.data?.enabled !== true)}
          >
            <span />
          </button>
        </div>
        <div className="management-row">
          <div>
            <strong>Sandbox</strong>
            <span>
              {sandbox.data?.backend ?? 'unknown'} ·{' '}
              {sandbox.data?.isolated === true ? 'isolated' : 'local'}
            </span>
          </div>
          <span className="managed-badge">
            {sandbox.data?.available === true ? 'available' : 'unavailable'}
          </span>
        </div>
        <div className="management-row">
          <div>
            <strong>OnlyOffice</strong>
            <span>
              {onlyOffice.data?.enabled === true ? 'enabled' : 'disabled'} ·{' '}
              {onlyOffice.data?.projectFileEditEnabled === true ? 'project edit' : 'view only'}
            </span>
          </div>
          <button className="small-button" onClick={() => setShowOnlyOfficeForm((open) => !open)}>
            {showOnlyOfficeForm ? '取消' : '配置'}
          </button>
        </div>
      </div>
      {showOnlyOfficeForm && onlyOffice.data !== undefined ? (
        <JsonCreateForm
          initial={{
            config: {
              enabled: onlyOffice.data.enabled,
              ...(onlyOffice.data.documentServerUrl === undefined
                ? {}
                : { documentServerUrl: onlyOffice.data.documentServerUrl }),
              ...(onlyOffice.data.publicApiBase === undefined
                ? {}
                : { publicApiBase: onlyOffice.data.publicApiBase }),
              lang: onlyOffice.data.lang,
              projectFileEditEnabled: onlyOffice.data.projectFileEditEnabled,
              runArtifactEditEnabled: onlyOffice.data.runArtifactEditEnabled,
            },
            secretAction: 'preserve',
          }}
          submitLabel="保存文档集成"
          busy={updateOnlyOffice.isPending}
          error={updateOnlyOffice.error}
          onSubmit={updateOnlyOffice.mutate}
        />
      ) : null}
    </SettingsSection>
  );
}

function SettingsSection(props: {
  readonly title: string;
  readonly description: string;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="settings-section">
      <div className="settings-copy split">
        <div>
          <h3>{props.title}</h3>
          <p>{props.description}</p>
        </div>
        {props.action}
      </div>
      {props.children}
    </div>
  );
}

function ToggleFormButton(props: {
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
  readonly label: string;
}) {
  return (
    <button className="small-button" onClick={() => props.setOpen(!props.open)}>
      {props.open ? '取消' : props.label}
    </button>
  );
}

function DeleteButton(props: { readonly label: string; readonly onClick: () => void }) {
  return (
    <button className="danger-icon" title={props.label} onClick={props.onClick}>
      <Trash2 size={14} />
    </button>
  );
}

function JsonCreateForm(props: {
  readonly initial: unknown;
  readonly submitLabel: string;
  readonly busy: boolean;
  readonly error: Error | null;
  readonly onSubmit: (value: unknown) => void;
}) {
  const [source, setSource] = useState(JSON.stringify(props.initial, null, 2));
  const [parseError, setParseError] = useState('');
  return (
    <form
      className="settings-form"
      onSubmit={(event) => {
        event.preventDefault();
        try {
          props.onSubmit(JSON.parse(source) as unknown);
          setParseError('');
        } catch (error) {
          setParseError(error instanceof Error ? error.message : 'Invalid JSON.');
        }
      }}
    >
      <textarea
        className="config-source"
        value={source}
        onChange={(event) => setSource(event.target.value)}
        spellCheck={false}
      />
      {parseError !== '' || props.error !== null ? (
        <div className="form-error">
          <CircleAlert size={13} />
          {parseError || props.error?.message}
        </div>
      ) : null}
      <button className="primary" disabled={props.busy}>
        {props.submitLabel}
      </button>
    </form>
  );
}
