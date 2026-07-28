import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { SkillService } from '../../services/skill-service.js';
import { decodeBase64 } from '../base64.js';

const metadataSchema = {
  name: z.string().optional(),
  description: z.string().optional(),
  category: z.string().optional(),
};
const installSchema = z.discriminatedUnion('format', [
  z
    .object({
      format: z.literal('markdown'),
      content: z.string().min(1),
      ...metadataSchema,
    })
    .strict(),
  z
    .object({
      format: z.literal('zip'),
      contentBase64: z.string().min(1),
      ...metadataSchema,
    })
    .strict(),
]);

export function registerSkillRoutes(server: FastifyInstance, skills: SkillService): void {
  server.get('/api/v1/skills', async () => skills.list());

  server.get('/api/v1/skills/view', async (request) => {
    const query = z
      .object({ name: z.string().min(1), filePath: z.string().optional() })
      .parse(request.query);
    return skills.view(query.name, query.filePath);
  });

  server.post('/api/v1/skills', async (request, reply) => {
    const input = installSchema.parse(request.body);
    const options = {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.category === undefined ? {} : { category: input.category }),
    };
    const installed =
      input.format === 'markdown'
        ? await skills.installMarkdown(input.content, options)
        : await skills.installArchive(decodeBase64(input.contentBase64), options);
    return reply.status(201).send({ skill: installed });
  });

  server.delete('/api/v1/skills', async (request, reply) => {
    const query = z.object({ name: z.string().min(1) }).parse(request.query);
    await skills.delete(query.name);
    return reply.status(204).send();
  });
}
