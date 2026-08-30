import { basename } from 'node:path';
import { lstat, readFile, realpath } from 'node:fs/promises';

import {
  defineToolAgent,
  mcpServerConfigSchema,
  type JsonValue,
  type RunEvent,
  type RunId,
} from 'dagent-ai';
import { maxArtifactUploadFileBytes, maxArtifactUploadTotalBytes } from 'dagent-ai/contracts';
import type { ApplicationRuntime, ModelProviderInput } from 'dagent-ai-app';
import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';

import {
  desktopInvokeChannel,
  desktopRequestSchema,
  desktopRunEventChannel,
  type AttachmentGrant,
  type DesktopBootstrap,
  type DesktopResources,
  type DesktopResult,
  type FolderGrant,
  type ParsedDesktopRequest,
} from '../shared/contracts.js';
import { trustedRendererUrl } from './security.js';
import { gitDiff, gitStatus } from './workspace/git.js';
import { compareSnapshots, scanWorkspace, type WorkspaceSnapshot } from './workspace/scanner.js';

type StoredAttachmentGrant = AttachmentGrant & { readonly path: string };

const runChangesSchema = z
  .object({
    runId: z.string(),
    capturedAt: z.string(),
    truncated: z.boolean(),
    files: z.array(
      z.object({
        path: z.string(),
        status: z.enum(['added', 'modified', 'deleted']),
        beforeSize: z.number().optional(),
        afterSize: z.number().optional(),
        diff: z.string().optional(),
      }),
    ),
  })
  .strict();

export function registerDesktopIpc(runtime: ApplicationRuntime): () => void {
  const folderGrants = new Map<string, FolderGrant>();
  const attachmentGrants = new Map<string, StoredAttachmentGrant>();
  const runSubscriptions = new Map<RunId, () => void>();
  const beforeSnapshots = new Map<
    RunId,
    { readonly root: string; readonly snapshot: WorkspaceSnapshot }
  >();

  const handler = async (event: IpcMainInvokeEvent, raw: unknown): Promise<DesktopResult> => {
    try {
      validateSender(event);
      const request = desktopRequestSchema.parse(raw);
      return { ok: true, value: await dispatch(request, event) };
    } catch (error) {
      return { ok: false, error: desktopError(error) };
    }
  };

  ipcMain.handle(desktopInvokeChannel, handler);

  async function dispatch(
    request: ParsedDesktopRequest,
    event: IpcMainInvokeEvent,
  ): Promise<unknown> {
    switch (request.action) {
      case 'bootstrap':
        return bootstrap(runtime);
      case 'dialog:folder':
        return selectFolder(event);
      case 'dialog:attachments':
        return selectAttachments(event);
      case 'project:create': {
        const grant = folderGrants.get(request.grantId);
        if (grant === undefined) throw new Error('The selected folder grant has expired.');
        folderGrants.delete(request.grantId);
        return runtime.repository.createProject({
          name: request.name,
          rootPath: grant.path,
          ...(request.description === undefined ? {} : { description: request.description }),
        });
      }
      case 'project:delete':
        return { deleted: await runtime.repository.deleteProject(request.projectId) };
      case 'conversation:create':
        return runtime.repository.createConversation({
          title: request.title,
          kind: 'chat',
          ...(request.projectId === undefined
            ? { workspaceScope: 'standalone' as const }
            : { projectId: request.projectId, workspaceScope: 'project' as const }),
        });
      case 'conversation:delete':
        return { deleted: await runtime.repository.deleteConversation(request.conversationId) };
      case 'run:start':
        return startRun(request, event);
      case 'run:cancel':
        return { cancelled: runtime.runs.cancel(request.runId) };
      case 'run:review':
        await runtime.runs.resume(request.runId, request.decision);
        return { resumed: true };
      case 'run:events':
        return { events: await runtime.runs.eventsAfter(request.runId, request.after) };
      case 'file:inspect':
        return runtime.projectFiles.inspect(request.projectId, request.path);
      case 'file:read':
        return runtime.projectFiles.download(request.projectId, request.path);
      case 'changes:get': {
        const stored = await runtime.repository.setting(changesKey(request.runId));
        return stored === undefined
          ? { runId: request.runId, capturedAt: '', truncated: false, files: [] }
          : runChangesSchema.parse(stored);
      }
      case 'git:status':
        return gitStatus(await projectRoot(request.projectId));
      case 'git:diff':
        return { diff: await gitDiff(await projectRoot(request.projectId), request.path) };
      case 'resources:list':
        return resources(runtime);
      case 'model:create':
        return runtime.models.create(modelInput(request.input));
      case 'model:update':
        return runtime.models.update(request.id, modelInput(request.input));
      case 'model:activate':
        return runtime.models.activate(request.id);
      case 'model:delete':
        await runtime.models.delete(request.id);
        return { deleted: true };
      case 'mcp:create':
        return runtime.mcpServers.create(mcpServerConfigSchema.parse(request.config));
      case 'mcp:update':
        return runtime.mcpServers.update(
          request.name,
          mcpServerConfigSchema.parse(request.config),
          request.secretAction,
        );
      case 'mcp:delete':
        await runtime.mcpServers.delete(request.name);
        return { deleted: true };
      case 'mcp:reload':
        return runtime.mcpServers.reload();
      case 'skill:install':
        return runtime.skills.installMarkdown(request.content, {
          ...(request.name === undefined ? {} : { name: request.name }),
          ...(request.description === undefined ? {} : { description: request.description }),
        });
      case 'skill:view':
        return runtime.skills.view(request.name);
      case 'skill:delete':
        await runtime.skills.delete(request.name);
        return { deleted: true };
      case 'agent:save':
        return request.existingId === undefined
          ? runtime.agents.create(request.config)
          : runtime.agents.update(request.existingId, request.config);
      case 'agent:delete':
        await runtime.agents.delete(request.id);
        return { deleted: true };
    }
  }

  async function selectFolder(event: IpcMainInvokeEvent): Promise<FolderGrant | undefined> {
    const result = await dialog.showOpenDialog(parentWindow(event), {
      title: 'Open a project folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    const selected = result.filePaths[0];
    if (result.canceled || selected === undefined) return undefined;
    const path = await realpath(selected);
    if (!(await lstat(path)).isDirectory())
      throw new Error('The selected path is not a directory.');
    const grant = {
      grantId: crypto.randomUUID(),
      path,
      name: basename(path),
    } satisfies FolderGrant;
    folderGrants.set(grant.grantId, grant);
    return grant;
  }

  async function selectAttachments(event: IpcMainInvokeEvent): Promise<readonly AttachmentGrant[]> {
    const result = await dialog.showOpenDialog(parentWindow(event), {
      title: 'Attach files',
      properties: ['openFile', 'multiSelections'],
    });
    if (result.canceled) return [];
    const grants: AttachmentGrant[] = [];
    for (const selected of result.filePaths.slice(0, 32)) {
      const path = await realpath(selected);
      const info = await lstat(path);
      if (!info.isFile() || info.size > maxArtifactUploadFileBytes) continue;
      const grant = {
        grantId: crypto.randomUUID(),
        path,
        name: basename(path),
        size: info.size,
      } satisfies StoredAttachmentGrant;
      attachmentGrants.set(grant.grantId, grant);
      grants.push({ grantId: grant.grantId, name: grant.name, size: grant.size });
    }
    return grants;
  }

  async function startRun(
    request: Extract<ParsedDesktopRequest, { readonly action: 'run:start' }>,
    event: IpcMainInvokeEvent,
  ): Promise<{ readonly runId: RunId }> {
    const conversation = await runtime.repository.getConversation(request.conversationId);
    if (conversation === undefined) throw new Error('Conversation not found.');
    const capabilities = unique(request.capabilityIds);
    for (const id of capabilities) {
      const binding = runtime.runner.catalog.get(id);
      if (binding === undefined || !binding.definition.enabled) {
        throw new Error(`Capability '${id}' is unavailable.`);
      }
    }
    const availableSkills = new Set(
      (await runtime.runner.skills.list()).flatMap((skill) => [skill.name, skill.qualifiedName]),
    );
    const skills = unique(request.skillIds);
    for (const id of skills) {
      if (!availableSkills.has(id)) throw new Error(`Skill '${id}' is unavailable.`);
    }
    const agents = unique(request.agentIds);
    for (const id of agents) {
      const agent = runtime.runner.agent(id);
      if (agent === undefined || agent.kind !== 'tool-agent') {
        throw new Error(`ToolAgent '${id}' is unavailable.`);
      }
    }
    const uploads = [];
    let totalBytes = 0;
    for (const grantId of unique(request.attachmentGrantIds)) {
      const grant = attachmentGrants.get(grantId);
      if (grant === undefined) throw new Error('An attachment grant has expired.');
      attachmentGrants.delete(grantId);
      totalBytes += grant.size;
      if (totalBytes > maxArtifactUploadTotalBytes) throw new Error('Attachments exceed 100 MiB.');
      uploads.push({ filename: grant.name, content: await readFile(grant.path) });
    }

    let root: string | undefined;
    let before: WorkspaceSnapshot | undefined;
    if (conversation.projectId !== undefined) {
      root = await projectRoot(conversation.projectId);
      before = await scanWorkspace(root);
    }
    const target = defineToolAgent({
      kind: 'tool-agent',
      id: 'DagentWorkAgent',
      name: 'DagentWork',
      description: 'Local desktop coding and knowledge-work agent.',
      systemPrompt:
        'Work directly in the selected local project. Be precise, preserve unrelated changes, and explain the result clearly.',
      scope: { capabilities: [...capabilities], skills: [...skills], agents: [...agents] },
      reviewLevel: request.reviewLevel,
      maxSteps: 50,
    });
    const runId = await runtime.runs.start({
      conversationId: request.conversationId,
      target,
      runInput: {
        prompt: request.prompt,
        ...(uploads.length === 0 ? {} : { uploads }),
      },
    });
    if (root !== undefined && before !== undefined)
      beforeSnapshots.set(runId, { root, snapshot: before });
    subscribeToRun(runId, event);
    return { runId };
  }

  function subscribeToRun(runId: RunId, event: IpcMainInvokeEvent): void {
    runSubscriptions.get(runId)?.();
    let finished = false;
    let unsubscribe = (): void => undefined;
    const handleEvent = (runEvent: RunEvent): void => {
      const notifyRenderer = (): void => {
        if (!event.sender.isDestroyed()) {
          event.sender.send(desktopRunEventChannel, { event: runEvent });
        }
      };
      if (
        !finished &&
        runEvent.type === 'run-completed' &&
        runEvent.outcome !== 'awaiting-review'
      ) {
        finished = true;
        unsubscribe();
        runSubscriptions.delete(runId);
        void captureChanges(runId)
          .catch(() => undefined)
          .then(notifyRenderer);
        return;
      }
      notifyRenderer();
    };
    unsubscribe = runtime.runs.on(runId, handleEvent);
    runSubscriptions.set(runId, unsubscribe);
    void runtime.runs.eventsAfter(runId, 0).then((events) => {
      for (const runEvent of events) handleEvent(runEvent);
    });
  }

  async function captureChanges(runId: RunId): Promise<void> {
    const before = beforeSnapshots.get(runId);
    beforeSnapshots.delete(runId);
    if (before === undefined) return;
    const changes = compareSnapshots(runId, before.snapshot, await scanWorkspace(before.root));
    await runtime.repository.setSetting(changesKey(runId), changes as unknown as JsonValue);
  }

  async function projectRoot(projectId: string): Promise<string> {
    const project = await runtime.repository.getProject(projectId);
    if (project === undefined) throw new Error('Project not found.');
    return project.rootPath;
  }

  return () => {
    ipcMain.removeHandler(desktopInvokeChannel);
    for (const unsubscribe of runSubscriptions.values()) unsubscribe();
    runSubscriptions.clear();
    beforeSnapshots.clear();
    folderGrants.clear();
    attachmentGrants.clear();
  };
}

async function bootstrap(runtime: ApplicationRuntime): Promise<DesktopBootstrap> {
  const [projects, conversations, runs, loadedResources] = await Promise.all([
    runtime.repository.listProjects(),
    runtime.repository.listAllConversations(),
    runtime.repository.listRuns(),
    resources(runtime),
  ]);
  return { projects, conversations, runs, resources: loadedResources, version: '0.9.5' };
}

async function resources(runtime: ApplicationRuntime): Promise<DesktopResources> {
  const [models, mcp, skills, agents, profiles] = await Promise.all([
    runtime.models.list(),
    runtime.mcpServers.list(),
    runtime.skills.list(),
    runtime.agents.list(),
    runtime.profiles.list(),
  ]);
  return {
    models,
    mcp,
    skills,
    agents: agents.filter(({ config }) => config.kind === 'tool-agent'),
    capabilities: runtime.capabilities.list().capabilities,
    profiles,
  };
}

function modelInput(input: {
  readonly id: string;
  readonly name: string;
  readonly baseURL: string;
  readonly model: string;
  readonly apiKey?: string | undefined;
  readonly apiKeyAction?: 'preserve' | 'replace' | 'clear' | undefined;
  readonly timeoutMs: number;
  readonly contextWindowTokens: number;
  readonly outputReserveTokens: number;
  readonly streamIncludeUsage: boolean;
}): ModelProviderInput {
  return {
    id: input.id,
    name: input.name,
    baseURL: input.baseURL,
    model: input.model,
    ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
    ...(input.apiKeyAction === undefined ? {} : { apiKeyAction: input.apiKeyAction }),
    timeoutMs: input.timeoutMs,
    contextWindowTokens: input.contextWindowTokens,
    outputReserveTokens: input.outputReserveTokens,
    streamIncludeUsage: input.streamIncludeUsage,
    extraRequestArgs: {},
    extraBody: {},
  };
}

function validateSender(event: IpcMainInvokeEvent): void {
  if (
    event.senderFrame === null ||
    event.senderFrame !== event.sender.mainFrame ||
    !trustedRendererUrl(event.senderFrame.url)
  ) {
    throw new Error('Invalid desktop command sender.');
  }
}

function parentWindow(event: IpcMainInvokeEvent): BrowserWindow {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window === null) throw new Error('Desktop window is unavailable.');
  return window;
}

function desktopError(error: unknown): { readonly code: string; readonly message: string } {
  if (error instanceof z.ZodError) {
    return { code: 'INVALID_REQUEST', message: 'The desktop request is invalid.' };
  }
  if (error instanceof Error) return { code: 'DESKTOP_ERROR', message: error.message };
  return { code: 'DESKTOP_ERROR', message: 'The desktop operation failed.' };
}

function changesKey(runId: string): string {
  return `desktop.run-changes.${runId}`;
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
