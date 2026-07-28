import { autoAgentSchema, dagAgentSchema, toolAgentSchema } from 'dagent-ai/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { AgentService } from '../../services/agent-service.js';

const agentSchema = z.discriminatedUnion('kind', [
  toolAgentSchema,
  dagAgentSchema,
  autoAgentSchema,
]);
const agentParametersSchema = z.object({ id: z.string().min(1) });

export function registerAgentRoutes(server: FastifyInstance, agents: AgentService): void {
  server.get('/api/v1/agents', async () => agents.list());

  server.get('/api/v1/agents/:id', async (request) => {
    const { id } = agentParametersSchema.parse(request.params);
    return agents.get(id);
  });

  server.post('/api/v1/agents', async (request, reply) => {
    const config = agentSchema.parse(request.body);
    return reply.status(201).send(await agents.create(config));
  });

  server.put('/api/v1/agents/:id', async (request) => {
    const { id } = agentParametersSchema.parse(request.params);
    return agents.update(id, agentSchema.parse(request.body));
  });

  server.delete('/api/v1/agents/:id', async (request, reply) => {
    const { id } = agentParametersSchema.parse(request.params);
    await agents.delete(id);
    return reply.status(204).send();
  });
}
