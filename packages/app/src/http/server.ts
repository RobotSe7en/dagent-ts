import { resolve } from 'node:path';

import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { DagentError } from 'dagent-ai';
import type { ChatProvider, Runner } from 'dagent-ai';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';

import packageMetadata from '../../package.json' with { type: 'json' };
import { createApplicationRuntime, type ApplicationRuntime } from '../application-runtime.js';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../database/database.js';
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
import { registerDagDesignRoutes } from './routes/dag-design.js';

export type Application = {
  readonly server: FastifyInstance;
  readonly runner: Runner;
  readonly database: AppDatabase;
  readonly runtime: ApplicationRuntime;
  close(): Promise<void>;
};

export async function createApplication(options: {
  readonly config: AppConfig;
  readonly provider: ChatProvider;
  readonly logger?: boolean;
}): Promise<Application> {
  const runtime = await createApplicationRuntime(options);
  const {
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
  } = runtime;
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
  registerDagDesignRoutes(server, runner);

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
    runtime,
    async close() {
      await server.close();
      await runtime.close();
    },
  };
}
