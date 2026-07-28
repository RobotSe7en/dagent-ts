import { mcpServerConfigSchema } from 'dagent-ai';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { McpServerService } from '../../services/mcp-server-service.js';

const nameParametersSchema = z.object({ name: z.string().min(1) });
const updateSchema = z
  .object({
    config: mcpServerConfigSchema,
    secretAction: z.enum(['preserve', 'replace', 'clear']).default('preserve'),
  })
  .strict();

export function registerMcpRoutes(server: FastifyInstance, mcpServers: McpServerService): void {
  server.get('/api/v1/mcp/servers', async () => mcpServers.list());

  server.get('/api/v1/mcp/servers/:name', async (request) => {
    const { name } = nameParametersSchema.parse(request.params);
    return { server: await mcpServers.get(name) };
  });

  server.post('/api/v1/mcp/servers', async (request, reply) =>
    reply.status(201).send({
      server: await mcpServers.create(mcpServerConfigSchema.parse(request.body)),
    }),
  );

  server.put('/api/v1/mcp/servers/:name', async (request) => {
    const { name } = nameParametersSchema.parse(request.params);
    const input = updateSchema.parse(request.body);
    return {
      server: await mcpServers.update(name, input.config, input.secretAction),
    };
  });

  server.delete('/api/v1/mcp/servers/:name', async (request, reply) => {
    const { name } = nameParametersSchema.parse(request.params);
    await mcpServers.delete(name);
    return reply.status(204).send();
  });

  server.post('/api/v1/mcp/reload', async () => mcpServers.reload());
}
