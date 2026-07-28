import type {
  AutoAgent,
  ConversationState,
  DagAgent,
  DAGSpec,
  JsonObject,
  ReviewDecision,
  RunEvent,
  RunId,
  RunTarget,
  ToolAgent,
} from 'dagent-ai';
import type { CapabilityDefinition } from 'dagent-ai/contracts';

export type Project = {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly rootPath: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type ConversationSummary = {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly kind: 'chat' | 'dynamic-dag' | 'static-dag';
  readonly schemaVersion: 3 | 'legacy';
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type Conversation = ConversationSummary & {
  readonly conversation: ConversationState;
};

export type StoredRun = {
  readonly id: RunId;
  readonly conversationId?: string;
  readonly checkpoint?: {
    readonly state: {
      readonly status: string;
      readonly graph?: DAGSpec;
      readonly pendingReview?: {
        readonly id: string;
        readonly revision: number;
        readonly summary: string;
      };
    };
  };
  readonly status: string;
};

export type SkillEntry = {
  readonly name: string;
  readonly qualifiedName: string;
  readonly description: string;
  readonly category?: string;
  readonly managed: boolean;
};

export type McpStatus = {
  readonly name: string;
  readonly source: 'config' | 'managed';
  readonly editable: boolean;
  readonly deletable: boolean;
  readonly status: 'connected' | 'disabled' | 'error';
  readonly error?: string;
  readonly config: {
    readonly transport: 'stdio' | 'http';
    readonly enabled: boolean;
    readonly risk: string;
    readonly secretNames: readonly string[];
    readonly secretsConfigured: boolean;
  };
  readonly tools: readonly CapabilityDefinition[];
};

export type StoredAgent = {
  readonly config: ToolAgent | DagAgent | AutoAgent;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type ModelProvider = {
  readonly id: string;
  readonly name: string;
  readonly source: 'config' | 'managed';
  readonly baseURL: string;
  readonly model: string;
  readonly active: boolean;
  readonly editable: boolean;
  readonly deletable: boolean;
  readonly apiKeyConfigured: boolean;
  readonly apiKeySaved: boolean;
  readonly apiKeyEnv?: string;
  readonly timeoutMs: number;
  readonly contextWindowTokens: number;
  readonly outputReserveTokens: number;
  readonly streamIncludeUsage: boolean;
  readonly extraRequestArgs: Readonly<Record<string, unknown>>;
};

export type ProfileDescriptor = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly content: string;
  readonly source: 'builtin' | 'managed' | 'config';
  readonly editable: boolean;
  readonly deletable: boolean;
};

export type CapabilityModule = {
  readonly id: string;
  readonly source: 'config' | 'path' | 'managed';
  readonly editable: boolean;
  readonly deletable: boolean;
  readonly status: 'active' | 'disabled' | 'error';
  readonly path: string;
  readonly exports: readonly string[];
  readonly enabled: boolean;
  readonly error?: string;
  readonly capabilities: readonly CapabilityDefinition[];
};

export type ValidationSettings = {
  readonly enabled: boolean;
  readonly maxRetries: number;
  readonly profile?: string;
};

export type SandboxStatus = {
  readonly enabled: boolean;
  readonly backend: string;
  readonly available: boolean;
  readonly isolated: boolean;
  readonly error?: string;
};

export type OnlyOfficeSettings = {
  readonly enabled: boolean;
  readonly documentServerUrl?: string;
  readonly publicApiBase?: string;
  readonly lang: string;
  readonly projectFileEditEnabled: boolean;
  readonly runArtifactEditEnabled: boolean;
  readonly jwtSecretConfigured: boolean;
};

export type OnlyOfficeEditorConfig = {
  readonly documentServerUrl: string;
  readonly scriptUrl: string;
  readonly config: Readonly<Record<string, unknown>>;
};

export type ProjectFile =
  | {
      readonly path: string;
      readonly type: 'directory';
      readonly entries: readonly {
        readonly path: string;
        readonly name: string;
        readonly type: 'directory' | 'file';
        readonly size: number;
        readonly modifiedAt: string;
      }[];
    }
  | {
      readonly path: string;
      readonly type: 'file';
      readonly name: string;
      readonly size: number;
      readonly modifiedAt: string;
      readonly mediaType: string;
      readonly content?: string;
      readonly previewOmitted?: 'binary' | 'too-large';
    };

export class ApiError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    headers,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as
      { error?: { code?: string; message?: string } } | undefined;
    throw new ApiError(
      body?.error?.message ?? `Request failed (${response.status}).`,
      response.status,
      body?.error?.code ?? 'HTTP_ERROR',
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  listProjects: () => request<readonly Project[]>('/projects'),
  createProject: (input: { readonly name: string; readonly rootPath: string }) =>
    request<Project>('/projects', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  listConversations: (projectId: string) =>
    request<readonly ConversationSummary[]>(`/projects/${projectId}/conversations`),
  createConversation: (input: { readonly projectId: string; readonly title: string }) =>
    request<Conversation>('/conversations', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  conversation: (id: string) => request<Conversation>(`/conversations/${id}`),
  capabilities: async () =>
    (await request<{ readonly capabilities: readonly CapabilityDefinition[] }>('/capabilities'))
      .capabilities,
  setCapabilityEnabled: (id: string, enabled: boolean) =>
    request<{ readonly capability: CapabilityDefinition }>(
      `/capabilities/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      },
    ),
  skills: async () => (await request<{ readonly skills: readonly SkillEntry[] }>('/skills')).skills,
  installSkill: (input: {
    readonly content: string;
    readonly name?: string;
    readonly description?: string;
    readonly category?: string;
  }) =>
    request('/skills', {
      method: 'POST',
      body: JSON.stringify({ format: 'markdown', ...input }),
    }),
  deleteSkill: (name: string) =>
    request<undefined>(`/skills?name=${encodeURIComponent(name)}`, { method: 'DELETE' }),
  mcpServers: async () =>
    (await request<{ readonly servers: readonly McpStatus[] }>('/mcp/servers')).servers,
  connectMcp: async (config: unknown) =>
    (
      await request<{ readonly server: McpStatus }>('/mcp/servers', {
        method: 'POST',
        body: JSON.stringify(config),
      })
    ).server,
  disconnectMcp: (name: string) =>
    request<undefined>(`/mcp/servers/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  agents: () => request<readonly StoredAgent[]>('/agents'),
  createAgent: (config: StoredAgent['config']) =>
    request<StoredAgent>('/agents', { method: 'POST', body: JSON.stringify(config) }),
  updateAgent: (config: StoredAgent['config']) =>
    request<StoredAgent>(`/agents/${encodeURIComponent(config.id)}`, {
      method: 'PUT',
      body: JSON.stringify(config),
    }),
  deleteAgent: (id: string) =>
    request<undefined>(`/agents/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  models: () =>
    request<{ readonly models: readonly ModelProvider[]; readonly activeModelId: string }>(
      '/models',
    ),
  createModel: (config: unknown) =>
    request<{ readonly model: ModelProvider; readonly activeModelId: string }>('/models', {
      method: 'POST',
      body: JSON.stringify(config),
    }),
  activateModel: (id: string) =>
    request<{ readonly model: ModelProvider; readonly activeModelId: string }>(
      `/models/${encodeURIComponent(id)}/activate`,
      { method: 'POST' },
    ),
  deleteModel: (id: string) =>
    request<undefined>(`/models/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  profiles: () =>
    request<{
      readonly profiles: readonly ProfileDescriptor[];
      readonly warnings: readonly { readonly name: string; readonly error: string }[];
    }>('/profiles'),
  createProfile: (input: { readonly name: string; readonly content: string }) =>
    request<{ readonly profile: ProfileDescriptor }>('/profiles', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  deleteProfile: (name: string) =>
    request<undefined>(`/profiles/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  capabilityModules: async () =>
    (await request<{ readonly modules: readonly CapabilityModule[] }>('/capability-modules'))
      .modules,
  createCapabilityModule: (config: unknown) =>
    request<{ readonly module: CapabilityModule }>('/capability-modules', {
      method: 'POST',
      body: JSON.stringify(config),
    }),
  deleteCapabilityModule: (id: string) =>
    request<undefined>(`/capability-modules/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  validationSettings: () => request<ValidationSettings>('/settings/validation'),
  setValidationEnabled: (enabled: boolean) =>
    request<ValidationSettings>('/settings/validation', {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    }),
  sandboxStatus: () => request<SandboxStatus>('/sandbox/status'),
  onlyOfficeSettings: () => request<OnlyOfficeSettings>('/system/onlyoffice'),
  updateOnlyOffice: (input: unknown) =>
    request<OnlyOfficeSettings>('/system/onlyoffice', {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  projectOnlyOffice: (projectId: string, path: string) =>
    request<OnlyOfficeEditorConfig>(
      `/projects/${projectId}/files/onlyoffice/config?path=${encodeURIComponent(path)}`,
    ),
  startRun: (input: {
    readonly conversationId?: string;
    readonly target: RunTarget;
    readonly input:
      | {
          readonly prompt: string;
          readonly uploads?: readonly {
            readonly filename: string;
            readonly contentBase64: string;
          }[];
        }
      | { readonly graphInput: JsonObject };
  }) =>
    request<{ readonly runId: RunId }>('/runs', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  run: (id: RunId) => request<StoredRun>(`/runs/${id}`),
  cancelRun: (id: RunId) =>
    request<{ readonly cancelled: boolean }>(`/runs/${id}/cancel`, {
      method: 'POST',
    }),
  review: (id: RunId, decision: ReviewDecision) =>
    request<{ readonly runId: RunId }>(`/runs/${id}/reviews`, {
      method: 'POST',
      body: JSON.stringify(decision),
    }),
  validateDag: (graph: unknown) =>
    request<{ readonly graph: DAGSpec }>('/dags/validate', {
      method: 'POST',
      body: JSON.stringify(graph),
    }),
  file: (projectId: string, path = '') =>
    request<ProjectFile>(`/projects/${projectId}/files?path=${encodeURIComponent(path)}`),
};

export function subscribeRun(
  runId: RunId,
  listener: (event: RunEvent) => void,
  onError: (error: Event) => void,
): () => void {
  const source = new EventSource(`/api/v1/runs/${runId}/events`);
  const eventTypes: RunEvent['type'][] = [
    'run-started',
    'token',
    'plan-proposed',
    'review-required',
    'node-started',
    'node-completed',
    'capability-started',
    'capability-completed',
    'checkpoint',
    'context-compaction-started',
    'context-compaction-finished',
    'context-usage',
    'run-completed',
  ];
  for (const type of eventTypes) {
    source.addEventListener(type, (event) => {
      listener(JSON.parse((event as MessageEvent<string>).data) as RunEvent);
    });
  }
  source.onerror = onError;
  return () => {
    source.close();
  };
}
