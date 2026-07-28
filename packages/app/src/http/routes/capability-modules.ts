import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { CapabilityModuleService } from '../../services/capability-module-service.js';

const moduleIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/u);
const exportsSchema = z.array(z.string().trim().min(1)).min(1);
const moduleConfigSchema = z
  .object({
    id: moduleIdSchema,
    source: z.enum(['path', 'managed']),
    path: z.string().trim().min(1),
    exports: exportsSchema,
    enabled: z.boolean().default(true),
  })
  .strict();
const idParametersSchema = z.object({ id: moduleIdSchema });
const sourceContentSchema = z.string().max(1024 * 1024);

export function registerCapabilityModuleRoutes(
  server: FastifyInstance,
  modules: CapabilityModuleService,
): void {
  server.get('/api/v1/capability-modules', async () => modules.list());

  server.get('/api/v1/capability-modules/:id', async (request) => {
    const { id } = idParametersSchema.parse(request.params);
    return { module: await modules.get(id) };
  });

  server.get('/api/v1/capability-modules/:id/source', async (request) => {
    const { id } = idParametersSchema.parse(request.params);
    return modules.source(id);
  });

  server.post('/api/v1/capability-modules', async (request, reply) =>
    reply.status(201).send({
      module: await modules.createPath(moduleConfigSchema.parse(request.body)),
    }),
  );

  server.post('/api/v1/capability-modules/upload', async (request, reply) => {
    const input = z
      .object({
        id: moduleIdSchema,
        filename: z.string().trim().min(1),
        content: sourceContentSchema,
        exports: exportsSchema,
        enabled: z.boolean().default(true),
      })
      .strict()
      .parse(request.body);
    return reply.status(201).send({ module: await modules.upload(input) });
  });

  server.post('/api/v1/capability-modules/discover', async (request) => {
    const input = z
      .discriminatedUnion('source', [
        z.object({ source: z.literal('path'), path: z.string().trim().min(1) }).strict(),
        z
          .object({
            source: z.literal('content'),
            content: sourceContentSchema,
            extension: z.enum(['.js', '.mjs', '.ts', '.mts']),
          })
          .strict(),
      ])
      .parse(request.body);
    return {
      exports:
        input.source === 'path'
          ? await modules.discoverPath(input.path)
          : await modules.discoverContent(input.content, input.extension),
    };
  });

  server.post('/api/v1/capability-modules/validate', async (request) =>
    modules.validate(moduleConfigSchema.parse(request.body)),
  );

  server.post('/api/v1/capability-modules/reload', async () => modules.reload());

  server.put('/api/v1/capability-modules/:id', async (request) => {
    const { id } = idParametersSchema.parse(request.params);
    return { module: await modules.update(id, moduleConfigSchema.parse(request.body)) };
  });

  server.put('/api/v1/capability-modules/:id/source', async (request) => {
    const { id } = idParametersSchema.parse(request.params);
    const { content } = z.object({ content: sourceContentSchema }).strict().parse(request.body);
    return { module: await modules.replaceManagedSource(id, content) };
  });

  server.delete('/api/v1/capability-modules/:id', async (request, reply) => {
    const { id } = idParametersSchema.parse(request.params);
    await modules.delete(id);
    return reply.status(204).send();
  });
}
