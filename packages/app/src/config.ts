import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import type { McpServerConfig } from 'dagent-ai';
import { dockerSandboxConfigSchema, mcpServerConfigSchema } from 'dagent-ai';
import {
  extraSystemPromptSchema,
  jsonObjectSchema,
  runtimeDirectorySchema,
} from 'dagent-ai/contracts';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export const configuredCapabilityModuleSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/u),
    path: z.string().min(1),
    exports: z.array(z.string().trim().min(1)).min(1),
    enabled: z.boolean().default(true),
  })
  .strict();

export const appConfigSchema = z
  .object({
    host: z.string().default('127.0.0.1'),
    port: z.number().int().min(1).max(65_535).default(8000),
    dataDirectory: z.string().default(join(homedir(), '.dagent-ts')),
    runtimeDirectory: runtimeDirectorySchema.default('.runtime'),
    extraSystemPrompt: extraSystemPromptSchema.optional(),
    webRoot: z.string().optional(),
    provider: z
      .object({
        baseURL: z.url().default('https://api.openai.com/v1'),
        model: z.string().min(1).default('gpt-5-mini'),
        apiKey: z.string().optional(),
        apiKeyEnv: z.string().default('OPENAI_API_KEY'),
        timeoutMs: z.number().int().positive().default(60_000),
        reasoning: z
          .object({
            enabled: z.boolean().optional(),
            effort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
            budgetTokens: z.number().int().positive().optional(),
            capture: z.enum(['field', 'field-and-tags']).optional(),
          })
          .strict()
          .optional(),
        streamIncludeUsage: z.boolean().default(false),
        contextWindowTokens: z.number().int().min(1024).default(128_000),
        outputReserveTokens: z.number().int().nonnegative().default(8192),
        extraRequestArgs: jsonObjectSchema.default({}),
        extraBody: jsonObjectSchema.default({}),
      })
      .strict()
      .refine((provider) => provider.outputReserveTokens < provider.contextWindowTokens, {
        message: 'outputReserveTokens must be smaller than contextWindowTokens.',
        path: ['outputReserveTokens'],
      })
      .prefault({}),
    skillRoots: z.array(z.string()).default([]),
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
    sandbox: z
      .object({
        enabled: z.boolean().default(false),
        docker: dockerSandboxConfigSchema.partial().prefault({}),
      })
      .strict()
      .prefault({}),
    mcpServers: z.array(mcpServerConfigSchema).default([]),
    capabilityModules: z.array(configuredCapabilityModuleSchema).default([]),
  })
  .strict();

export type AppConfig = z.infer<typeof appConfigSchema>;

export async function loadAppConfig(path?: string): Promise<AppConfig> {
  const configRoot = path === undefined ? process.cwd() : dirname(resolve(path));
  const fromFile =
    path === undefined ? {} : (parseYaml(await readFile(resolve(path), 'utf8')) as unknown);
  const parsed = appConfigSchema.parse(fromFile);
  return appConfigSchema.parse({
    ...parsed,
    host: process.env['DAGENT_HOST'] ?? parsed.host,
    port:
      process.env['DAGENT_PORT'] === undefined ? parsed.port : Number(process.env['DAGENT_PORT']),
    dataDirectory: process.env['DAGENT_DATA_DIR'] ?? parsed.dataDirectory,
    capabilityModules: parsed.capabilityModules.map((module) => ({
      ...module,
      path: resolve(configRoot, module.path),
    })),
    skillRoots: parsed.skillRoots.map((root) => resolve(configRoot, root)),
    profiles: {
      ...(parsed.profiles.directory === undefined
        ? {}
        : { directory: resolve(configRoot, parsed.profiles.directory) }),
    },
    sandbox: {
      ...parsed.sandbox,
      docker: {
        ...parsed.sandbox.docker,
        skillDirectories:
          parsed.sandbox.docker.skillDirectories?.map((directory) =>
            resolve(configRoot, directory),
          ) ?? [],
      },
    },
    provider: {
      ...parsed.provider,
      baseURL: process.env['OPENAI_BASE_URL'] ?? parsed.provider.baseURL,
      model: process.env['OPENAI_MODEL'] ?? parsed.provider.model,
    },
  });
}

export function databasePath(config: AppConfig): string {
  return join(resolve(config.dataDirectory), 'dagent.sqlite3');
}

export function mcpConfigs(config: AppConfig): readonly McpServerConfig[] {
  return config.mcpServers;
}
