import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import {
  createFileTools,
  createMemoryTools,
  createShellTool,
  type CapabilityBinding,
} from './capabilities/index.js';
import {
  autoAgentSchema,
  contextPolicySchema,
  dagAgentSchema,
  executionLimitsSchema,
  resultStoragePolicySchema,
  toolAgentSchema,
} from './contracts/index.js';
import { mcpServerConfigSchema } from './mcp/index.js';
import { loadCapabilityModule } from './modules/index.js';
import { DagentError } from './errors.js';
import { isBuiltinProfileName, loadBuiltinProfile, ProfileStore } from './profiles/index.js';
import type { ChatProvider } from './providers/provider.js';
import { Runner } from './runner.js';
import { DockerSandbox, dockerSandboxConfigSchema } from './sandbox/index.js';

const moduleSchema = z
  .object({
    path: z.string().min(1),
    exports: z.array(z.string().min(1)).min(1),
  })
  .strict();

const limitsOverrideSchema = z
  .object({
    maxModelCalls: z.number().int().positive().optional(),
    maxCapabilityCalls: z.number().int().positive().optional(),
    maxNodeExecutions: z.number().int().positive().optional(),
    maxDurationMs: z.number().int().positive().optional(),
    maxConcurrency: z.number().int().positive().optional(),
  })
  .strict();

const contextOverrideSchema = z
  .object({
    compactionTriggerRatio: z.number().positive().max(1).optional(),
    keepRecentTurns: z.number().int().positive().optional(),
    summaryMaxTokens: z.number().int().min(64).optional(),
    maxToolResultTokens: z.number().int().min(64).optional(),
    maxTotalToolResultTokens: z.number().int().min(64).optional(),
    tokenSafetyMargin: z.number().min(0).max(1).optional(),
  })
  .strict();

const resultStorageOverrideSchema = z
  .object({
    maxInlineBytes: z.number().int().min(1024).optional(),
  })
  .strict();

export const runnerConfigSchema = z
  .object({
    builtins: z.array(z.enum(['files', 'shell', 'memory'])).default(['files', 'shell', 'memory']),
    sandbox: z
      .object({
        enabled: z.boolean().default(false),
        docker: dockerSandboxConfigSchema.partial().prefault({}),
      })
      .strict()
      .prefault({}),
    skills: z
      .object({
        roots: z.array(z.string()).default([]),
        managedRoot: z.string().optional(),
      })
      .strict()
      .prefault({}),
    profiles: z
      .object({
        directory: z.string().min(1).optional(),
      })
      .strict()
      .prefault({}),
    validation: z
      .object({
        enabled: z.boolean().default(false),
        maxRetries: z.number().int().nonnegative().default(1),
        profile: z.string().min(1).default('validator_agent'),
      })
      .strict()
      .prefault({}),
    mcpServers: z.array(mcpServerConfigSchema).default([]),
    modules: z.array(moduleSchema).default([]),
    agents: z.array(z.union([toolAgentSchema, dagAgentSchema, autoAgentSchema])).default([]),
    limits: limitsOverrideSchema.prefault({}),
    context: contextOverrideSchema.prefault({}),
    resultStorage: resultStorageOverrideSchema.prefault({}),
    contextWindowTokens: z.number().int().min(1024).optional(),
    outputReserveTokens: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine(
    (config) =>
      config.contextWindowTokens === undefined ||
      config.outputReserveTokens === undefined ||
      config.outputReserveTokens < config.contextWindowTokens,
    {
      message: 'outputReserveTokens must be smaller than contextWindowTokens.',
      path: ['outputReserveTokens'],
    },
  );

export type RunnerConfig = z.infer<typeof runnerConfigSchema>;

export async function createRunnerFromConfigFile(
  pathValue: string,
  options: {
    readonly provider: ChatProvider;
    readonly workspace: string;
    readonly runtimeDirectory: string;
    readonly extraSystemPrompt?: string;
    readonly capabilities?: readonly CapabilityBinding[];
  },
): Promise<Runner> {
  const path = resolve(pathValue);
  const root = dirname(path);
  const config = runnerConfigSchema.parse(parseYaml(await readFile(path, 'utf8')));
  const moduleCapabilities = (
    await Promise.all(
      config.modules.map((module) =>
        loadCapabilityModule({
          path: resolve(root, module.path),
          exports: module.exports,
          root,
        }),
      ),
    )
  ).flat();
  const sandbox = config.sandbox.enabled
    ? new DockerSandbox(dockerSandboxConfigSchema.parse(config.sandbox.docker))
    : undefined;
  const builtins: CapabilityBinding[] = [];
  if (config.builtins.includes('files')) builtins.push(...createFileTools());
  if (config.builtins.includes('memory')) builtins.push(...createMemoryTools());
  if (config.builtins.includes('shell')) {
    builtins.push(createShellTool(sandbox === undefined ? {} : { executor: sandbox }));
  }
  const validationProfile = config.validation.enabled
    ? await resolveConfiguredProfile(
        config.validation.profile,
        config.profiles.directory === undefined
          ? undefined
          : resolve(root, config.profiles.directory),
      )
    : undefined;
  const runner = new Runner({
    provider: options.provider,
    capabilities: [...builtins, ...moduleCapabilities, ...(options.capabilities ?? [])],
    agents: config.agents,
    workspace: resolve(options.workspace),
    runtimeDirectory: options.runtimeDirectory,
    ...(options.extraSystemPrompt === undefined
      ? {}
      : { extraSystemPrompt: options.extraSystemPrompt }),
    limits: executionLimitsSchema.parse(config.limits),
    context: contextPolicySchema.parse(config.context),
    resultStorage: resultStoragePolicySchema.parse(config.resultStorage),
    validation: {
      enabled: config.validation.enabled,
      maxRetries: config.validation.maxRetries,
      ...(validationProfile === undefined ? {} : { profile: validationProfile }),
    },
    skillRoots: config.skills.roots.map((path) => resolve(root, path)),
    ...(config.skills.managedRoot === undefined
      ? {}
      : { managedSkillRoot: resolve(root, config.skills.managedRoot) }),
    ...(config.contextWindowTokens === undefined
      ? {}
      : { contextWindowTokens: config.contextWindowTokens }),
    ...(config.outputReserveTokens === undefined
      ? {}
      : { outputReserveTokens: config.outputReserveTokens }),
  });
  try {
    for (const server of config.mcpServers) {
      const resolved =
        server.transport === 'stdio' && server.cwd !== undefined
          ? { ...server, cwd: resolve(root, server.cwd) }
          : server;
      await runner.connectMcp(resolved);
    }
    return runner;
  } catch (error) {
    await runner.close();
    throw error;
  }
}

async function resolveConfiguredProfile(name: string, profileRoot: string | undefined) {
  if (profileRoot !== undefined) {
    try {
      return await new ProfileStore(profileRoot).load(name);
    } catch (error) {
      if (!isMissingProfileError(error)) throw error;
    }
  }
  if (isBuiltinProfileName(name)) return loadBuiltinProfile(name);
  throw new DagentError('INVALID_INPUT', `Profile '${name}' does not exist.`);
}

function isMissingProfileError(error: unknown): boolean {
  if (!(error instanceof DagentError) || !(error.cause instanceof Error)) return false;
  return 'code' in error.cause && (error.cause as NodeJS.ErrnoException).code === 'ENOENT';
}
