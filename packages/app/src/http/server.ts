import { join, resolve } from 'node:path';

import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import {
  Runner,
  DockerSandbox,
  dockerSandboxConfigSchema,
  DagentError,
  assertValidDag,
  createFileTools,
  createMemoryTools,
  createShellTool,
} from 'dagent-ai';
import type { ChatProvider } from 'dagent-ai';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';

import packageMetadata from '../../package.json' with { type: 'json' };
import type { AppConfig } from '../config.js';
import { databasePath } from '../config.js';
import { openDatabase, type AppDatabase } from '../database/database.js';
import { WriterLease } from '../database/lease.js';
import { AppRepository } from '../database/repositories.js';
import { AgentRepository } from '../database/agent-repository.js';
import { ModelProviderRepository } from '../database/model-provider-repository.js';
import { McpServerRepository } from '../database/mcp-server-repository.js';
import { CapabilityModuleRepository } from '../database/capability-module-repository.js';
import { TemplateCapabilityRepository } from '../database/template-capability-repository.js';
import { SavedDagRepository } from '../database/saved-dag-repository.js';
import { OrchestrationRepository } from '../database/orchestration-repository.js';
import { RunService } from '../services/run-service.js';
import { ProfileService } from '../services/profile-service.js';
import { ProjectFileService } from '../services/project-file-service.js';
import { RunArtifactService } from '../services/run-artifact-service.js';
import { AgentService } from '../services/agent-service.js';
import { ModelProviderService } from '../services/model-provider-service.js';
import { McpServerService } from '../services/mcp-server-service.js';
import { CapabilityModuleService } from '../services/capability-module-service.js';
import { CapabilityService } from '../services/capability-service.js';
import { ValidationSettingsService } from '../services/validation-settings-service.js';
import { SkillService } from '../services/skill-service.js';
import { SandboxService } from '../services/sandbox-service.js';
import { RunRecoveryService } from '../services/run-recovery-service.js';
import { OnlyOfficeService } from '../services/onlyoffice-service.js';
import { SwitchableProvider } from '../services/switchable-provider.js';
import { registerAgentRoutes } from './routes/agents.js';
import { registerConversationRoutes } from './routes/conversations.js';
import { registerModelRoutes } from './routes/models.js';
import { registerMcpRoutes } from './routes/mcp.js';
import { registerCapabilityModuleRoutes } from './routes/capability-modules.js';
import { registerCapabilityRoutes } from './routes/capabilities.js';
import { registerValidationSettingsRoutes } from './routes/validation-settings.js';
import { registerSkillRoutes } from './routes/skills.js';
import { registerSandboxRoutes } from './routes/sandbox.js';
import { registerOrchestrationRoutes } from './routes/orchestration.js';
import { registerOnlyOfficeRoutes } from './routes/onlyoffice.js';
import { registerProfileRoutes } from './routes/profiles.js';
import { registerProjectFileRoutes } from './routes/project-files.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerRunArtifactRoutes } from './routes/run-artifacts.js';
import { registerRunRoutes } from './routes/runs.js';
import { registerSavedDagRoutes } from './routes/saved-dags.js';

export type Application = {
  readonly server: FastifyInstance;
  readonly runner: Runner;
  readonly database: AppDatabase;
  close(): Promise<void>;
};

export async function createApplication(options: {
  readonly config: AppConfig;
  readonly provider: ChatProvider;
  readonly logger?: boolean;
}): Promise<Application> {
  const database = await openDatabase(databasePath(options.config));
  const lease = await WriterLease.acquire(database);
  const profiles = new ProfileService({
    managedRoot: join(resolve(options.config.dataDirectory), 'profiles'),
    ...(options.config.profiles.directory === undefined
      ? {}
      : { configuredRoot: resolve(options.config.profiles.directory) }),
  });
  const validatorProfile = await profiles.resolve(options.config.validation.profile);
  const dockerSandbox = options.config.sandbox.enabled
    ? new DockerSandbox(dockerSandboxConfigSchema.parse(options.config.sandbox.docker))
    : undefined;
  const provider = new SwitchableProvider('configured', options.provider);
  const runner = new Runner({
    provider,
    workspace: join(resolve(options.config.dataDirectory), 'workspace'),
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
    managedSkillRoot: join(resolve(options.config.dataDirectory), 'skills'),
    validation: {
      enabled: options.config.validation.enabled,
      maxRetries: options.config.validation.maxRetries,
      profile: validatorProfile,
    },
  });
  const repository = new AppRepository(database);
  await new RunRecoveryService(repository).recover();
  const agentRepository = new AgentRepository(database);
  const modelRepository = new ModelProviderRepository(database);
  const mcpRepository = new McpServerRepository(database);
  const moduleRepository = new CapabilityModuleRepository(database);
  const templateRepository = new TemplateCapabilityRepository(database);
  const savedDags = new SavedDagRepository(database);
  const orchestration = new OrchestrationRepository(database);
  const runs = new RunService(runner, repository);
  const projectFiles = new ProjectFileService(repository);
  const runArtifacts = new RunArtifactService(repository);
  const onlyOffice = new OnlyOfficeService(repository, projectFiles, runArtifacts);
  const agents = new AgentService(runner, agentRepository);
  const models = new ModelProviderService(
    modelRepository,
    provider,
    options.provider,
    options.config.provider,
  );
  const mcpServers = new McpServerService(runner, mcpRepository, options.config.mcpServers);
  const modules = new CapabilityModuleService(
    runner,
    moduleRepository,
    options.config.capabilityModules,
    join(resolve(options.config.dataDirectory), 'capability-modules'),
  );
  const capabilities = new CapabilityService(runner, repository, templateRepository);
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
  const server = Fastify({
    logger: options.logger ?? true,
    routerOptions: { maxParamLength: 2048 },
  });
  await server.register(cors, {
    origin: false,
  });

  server.setErrorHandler((error, _request, reply) => {
    const message = error instanceof Error ? error.message : String(error);
    const applicationStatus =
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      typeof error.statusCode === 'number'
        ? error.statusCode
        : 500;
    const statusCode =
      error instanceof z.ZodError
        ? 400
        : error instanceof DagentError
          ? error.code === 'CONCURRENCY_CONFLICT' || error.code === 'STALE_REVIEW'
            ? 409
            : error.code === 'CAPABILITY_NOT_FOUND'
              ? 404
              : 400
          : applicationStatus;
    void reply.status(statusCode).send({
      error: {
        code:
          error instanceof z.ZodError
            ? 'INVALID_INPUT'
            : error instanceof DagentError
              ? error.code
              : typeof error === 'object' &&
                  error !== null &&
                  'code' in error &&
                  typeof error.code === 'string'
                ? error.code
                : 'APP_ERROR',
        message,
        ...(error instanceof z.ZodError ? { issues: error.issues } : {}),
      },
    });
  });

  server.get('/api/v1/health', async () => ({
    status: 'ok',
    version: packageMetadata.version,
  }));
  registerAgentRoutes(server, agents);
  registerModelRoutes(server, models);
  registerMcpRoutes(server, mcpServers);
  registerCapabilityModuleRoutes(server, modules);
  registerCapabilityRoutes(server, capabilities);
  registerValidationSettingsRoutes(server, validationSettings);
  registerSkillRoutes(server, skills);
  registerSandboxRoutes(server, sandbox);
  registerOnlyOfficeRoutes(server, onlyOffice);
  registerProfileRoutes(server, profiles);
  registerProjectFileRoutes(server, projectFiles);
  registerProjectRoutes(server, repository);
  registerConversationRoutes(server, repository);
  registerRunArtifactRoutes(server, runArtifacts);
  registerRunRoutes(server, repository, runs);
  registerSavedDagRoutes(server, savedDags, orchestration, repository, runs);
  registerOrchestrationRoutes(server, orchestration, repository, savedDags);

  server.post('/api/v1/dags/validate', async (request) => ({
    graph: assertValidDag(request.body),
  }));

  if (options.config.webRoot !== undefined) {
    await server.register(fastifyStatic, {
      root: resolve(options.config.webRoot),
      prefix: '/',
      wildcard: false,
    });
    server.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'API route not found.' },
        });
      }
      return reply.sendFile('index.html');
    });
  }

  return {
    server,
    runner,
    database,
    async close() {
      await server.close();
      await runs.close();
      await lease.close();
      await database.destroy();
    },
  };
}
