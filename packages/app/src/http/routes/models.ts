import { jsonObjectSchema } from 'dagent-ai/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { reasoningConfigSchema } from '../../database/model-provider-repository.js';
import type { ModelProviderService } from '../../services/model-provider-service.js';

const modelInputSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/u),
    name: z.string().trim().min(1).max(200),
    baseURL: z.url(),
    model: z.string().trim().min(1),
    apiKey: z.string().min(1).optional(),
    apiKeyAction: z.enum(['preserve', 'replace', 'clear']).default('preserve'),
    apiKeyEnv: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)
      .optional(),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(10 * 60 * 1000)
      .default(60_000),
    contextWindowTokens: z.number().int().min(1024).default(128_000),
    outputReserveTokens: z.number().int().nonnegative().default(8192),
    reasoning: reasoningConfigSchema.optional(),
    extraBody: jsonObjectSchema.default({}),
  })
  .strict()
  .refine((input) => input.outputReserveTokens < input.contextWindowTokens, {
    message: 'outputReserveTokens must be smaller than contextWindowTokens.',
    path: ['outputReserveTokens'],
  })
  .refine((input) => input.apiKeyAction !== 'replace' || input.apiKey !== undefined, {
    message: 'apiKey is required when apiKeyAction is replace.',
    path: ['apiKey'],
  });
const modelParametersSchema = z.object({ id: z.string().min(1) });

export function registerModelRoutes(server: FastifyInstance, models: ModelProviderService): void {
  server.get('/api/v1/models', async () => models.list());

  server.post('/api/v1/models', async (request, reply) => {
    const input = modelInputSchema.parse(request.body);
    return reply.status(201).send({
      model: await models.create(input),
      activeModelId: (await models.list()).activeModelId,
    });
  });

  server.put('/api/v1/models/:id', async (request) => {
    const { id } = modelParametersSchema.parse(request.params);
    return {
      model: await models.update(id, modelInputSchema.parse(request.body)),
      activeModelId: (await models.list()).activeModelId,
    };
  });

  server.delete('/api/v1/models/:id', async (request, reply) => {
    const { id } = modelParametersSchema.parse(request.params);
    await models.delete(id);
    return reply.status(204).send();
  });

  server.post('/api/v1/models/:id/activate', async (request) => {
    const { id } = modelParametersSchema.parse(request.params);
    return {
      model: await models.activate(id),
      activeModelId: id,
    };
  });
}
