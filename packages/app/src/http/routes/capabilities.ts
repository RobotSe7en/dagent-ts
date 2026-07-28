import { capabilityIdSchema, jsonObjectSchema } from 'dagent-ai/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { templateCapabilityConfigSchema } from '../../database/template-capability-repository.js';
import type { CapabilityService } from '../../services/capability-service.js';

const capabilityParametersSchema = z.object({ id: capabilityIdSchema });
const capabilityKindSchema = z.enum(['tool', 'mcp', 'agent', 'skill', 'memory']);

export function registerCapabilityRoutes(
  server: FastifyInstance,
  capabilities: CapabilityService,
): void {
  server.get('/api/v1/capabilities', async (request) => {
    const { kind } = z.object({ kind: capabilityKindSchema.optional() }).parse(request.query);
    return capabilities.list(kind);
  });

  server.get('/api/v1/capabilities/templates', async () => capabilities.listTemplates());

  server.post('/api/v1/capabilities/templates', async (request, reply) =>
    reply.status(201).send({
      capability: await capabilities.createTemplate(
        templateCapabilityConfigSchema.parse(request.body),
      ),
    }),
  );

  server.put('/api/v1/capabilities/templates/:id', async (request) => {
    const { id } = capabilityParametersSchema.parse(request.params);
    return {
      capability: await capabilities.updateTemplate(
        id,
        templateCapabilityConfigSchema.parse(request.body),
      ),
    };
  });

  server.delete('/api/v1/capabilities/templates/:id', async (request, reply) => {
    const { id } = capabilityParametersSchema.parse(request.params);
    await capabilities.deleteTemplate(id);
    return reply.status(204).send();
  });

  server.get('/api/v1/capabilities/:id', async (request) => {
    const { id } = capabilityParametersSchema.parse(request.params);
    return { capability: capabilities.get(id) };
  });

  server.patch('/api/v1/capabilities/:id', async (request) => {
    const { id } = capabilityParametersSchema.parse(request.params);
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(request.body);
    return { capability: await capabilities.setEnabled(id, enabled) };
  });

  server.post('/api/v1/capabilities/:id/test', async (request) => {
    const { id } = capabilityParametersSchema.parse(request.params);
    const input = z
      .object({
        arguments: jsonObjectSchema.default({}),
        metadata: jsonObjectSchema.default({}),
      })
      .strict()
      .parse(request.body);
    return {
      result: await capabilities.test(id, input.arguments, input.metadata),
    };
  });
}
