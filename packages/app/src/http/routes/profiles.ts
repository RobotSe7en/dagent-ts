import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { ProfileService } from '../../services/profile-service.js';

const profileCreateSchema = z
  .object({
    name: z.string().trim().min(1),
    content: z.string(),
  })
  .strict();

const profileUpdateSchema = z.object({ content: z.string() }).strict();
const profileParameterSchema = z.object({ name: z.string().min(1) });

export function registerProfileRoutes(server: FastifyInstance, profiles: ProfileService): void {
  server.get('/api/v1/profiles', async () => profiles.list());

  server.post('/api/v1/profiles', async (request, reply) => {
    const input = profileCreateSchema.parse(request.body);
    return reply.status(201).send({ profile: await profiles.create(input.name, input.content) });
  });

  server.put('/api/v1/profiles/:name', async (request, reply) => {
    const { name } = profileParameterSchema.parse(request.params);
    const { content } = profileUpdateSchema.parse(request.body);
    const profile = await profiles.update(name, content);
    return profile === undefined
      ? reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Managed profile not found.' } })
      : { profile };
  });

  server.delete('/api/v1/profiles/:name', async (request, reply) => {
    const { name } = profileParameterSchema.parse(request.params);
    return (await profiles.delete(name))
      ? reply.status(204).send()
      : reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Managed profile not found.' } });
  });
}
