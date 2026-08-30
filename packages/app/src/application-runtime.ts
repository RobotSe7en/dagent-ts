import { join, resolve } from 'node:path';

import {
  DockerSandbox,
  Runner,
  createFileTools,
  createMemoryTools,
  createShellTool,
  dockerSandboxConfigSchema,
} from 'dagent-ai';
import type { ChatProvider } from 'dagent-ai';

import type { AppConfig } from './config.js';
import { databasePath } from './config.js';
import { AgentRepository } from './database/agent-repository.js';
import { CapabilityModuleRepository } from './database/capability-module-repository.js';
import { openDatabase, type AppDatabase } from './database/database.js';
import { WriterLease } from './database/lease.js';
import { McpServerRepository } from './database/mcp-server-repository.js';
import { ModelProviderRepository } from './database/model-provider-repository.js';
import { OrchestrationRepository } from './database/orchestration-repository.js';
import { AppRepository } from './database/repositories.js';
import { SavedDagRepository } from './database/saved-dag-repository.js';
import { TemplateCapabilityRepository } from './database/template-capability-repository.js';
import { AgentService } from './services/agent-service.js';
import { CapabilityModuleService } from './services/capability-module-service.js';
import { CapabilityService } from './services/capability-service.js';
import { McpServerService } from './services/mcp-server-service.js';
import { ModelProviderService } from './services/model-provider-service.js';
import { OnlyOfficeService } from './services/onlyoffice-service.js';
import { ProfileService } from './services/profile-service.js';
import { ProjectFileService } from './services/project-file-service.js';
import { RunArtifactService } from './services/run-artifact-service.js';
import { RunRecoveryService } from './services/run-recovery-service.js';
import { RunService } from './services/run-service.js';
import { SandboxService } from './services/sandbox-service.js';
import { SkillService } from './services/skill-service.js';
import { SwitchableProvider } from './services/switchable-provider.js';
import { ValidationSettingsService } from './services/validation-settings-service.js';

export type ApplicationRuntime = {
  readonly database: AppDatabase;
  readonly runner: Runner;
  readonly repository: AppRepository;
  readonly savedDags: SavedDagRepository;
  readonly orchestration: OrchestrationRepository;
  readonly runs: RunService;
  readonly profiles: ProfileService;
  readonly projectFiles: ProjectFileService;
  readonly runArtifacts: RunArtifactService;
  readonly onlyOffice: OnlyOfficeService;
  readonly agents: AgentService;
  readonly models: ModelProviderService;
  readonly mcpServers: McpServerService;
  readonly modules: CapabilityModuleService;
  readonly capabilities: CapabilityService;
  readonly validationSettings: ValidationSettingsService;
  readonly skills: SkillService;
  readonly sandbox: SandboxService;
  close(): Promise<void>;
};

export async function createApplicationRuntime(options: {
  readonly config: AppConfig;
  readonly provider: ChatProvider;
  readonly database?: {
    readonly nativeBinding?: string;
  };
}): Promise<ApplicationRuntime> {
  const dataDirectory = resolve(options.config.dataDirectory);
  const database = await openDatabase(databasePath(options.config), options.database);
  const lease = await WriterLease.acquire(database);
  let runner: Runner | undefined;
  try {
    const profiles = new ProfileService({
      managedRoot: join(dataDirectory, 'profiles'),
      ...(options.config.profiles.directory === undefined
        ? {}
        : { configuredRoot: resolve(options.config.profiles.directory) }),
    });
    const validatorProfile = await profiles.resolve(options.config.validation.profile);
    const dockerSandbox = options.config.sandbox.enabled
      ? new DockerSandbox(dockerSandboxConfigSchema.parse(options.config.sandbox.docker))
      : undefined;
    const provider = new SwitchableProvider('configured', options.provider);
    runner = new Runner({
      provider,
      workspace: join(dataDirectory, 'workspace'),
      runtimeDirectory: options.config.runtimeDirectory,
      ...(options.config.extraSystemPrompt === undefined
        ? {}
        : { extraSystemPrompt: options.config.extraSystemPrompt }),
      capabilities: [
        ...createFileTools(),
        createShellTool(dockerSandbox === undefined ? {} : { executor: dockerSandbox }),
        ...createMemoryTools(),
      ],
      skillRoots: options.config.skillRoots,
      managedSkillRoot: join(dataDirectory, 'skills'),
      validation: {
        enabled: options.config.validation.enabled,
        maxRetries: options.config.validation.maxRetries,
        profile: validatorProfile,
      },
    });
    const repository = new AppRepository(database);
    await new RunRecoveryService(repository).recover();
    const savedDags = new SavedDagRepository(database);
    const orchestration = new OrchestrationRepository(database);
    const runs = new RunService(runner, repository, {
      savedDagRuns: join(dataDirectory, 'projects', '_runs'),
      standaloneConversations: join(dataDirectory, 'projects', '_standalone'),
    });
    const projectFiles = new ProjectFileService(repository);
    const runArtifacts = new RunArtifactService(repository);
    const onlyOffice = new OnlyOfficeService(repository, projectFiles, runArtifacts);
    const agents = new AgentService(runner, new AgentRepository(database));
    const models = new ModelProviderService(
      new ModelProviderRepository(database),
      provider,
      options.provider,
      options.config.provider,
    );
    const mcpServers = new McpServerService(
      runner,
      new McpServerRepository(database),
      options.config.mcpServers,
    );
    const modules = new CapabilityModuleService(
      runner,
      new CapabilityModuleRepository(database),
      options.config.capabilityModules,
      join(dataDirectory, 'capability-modules'),
    );
    const capabilities = new CapabilityService(
      runner,
      repository,
      new TemplateCapabilityRepository(database),
    );
    const validationSettings = new ValidationSettingsService(runner, repository);
    const skills = new SkillService(runner);
    const sandbox = new SandboxService(dockerSandbox);
    await models.initialize();
    await mcpServers.initialize();
    await modules.initialize();
    await capabilities.initialize();
    await validationSettings.initialize();
    await onlyOffice.initialize();
    await agents.initialize();
    let closed = false;
    return {
      database,
      runner,
      repository,
      savedDags,
      orchestration,
      runs,
      profiles,
      projectFiles,
      runArtifacts,
      onlyOffice,
      agents,
      models,
      mcpServers,
      modules,
      capabilities,
      validationSettings,
      skills,
      sandbox,
      async close() {
        if (closed) return;
        closed = true;
        await runs.close();
        await lease.close();
        await database.destroy();
      },
    };
  } catch (error) {
    await runner?.close().catch(() => undefined);
    await lease.close().catch(() => undefined);
    await database.destroy().catch(() => undefined);
    throw error;
  }
}
