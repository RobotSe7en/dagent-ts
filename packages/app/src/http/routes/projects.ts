import { resolve } from 'node:path';

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import type { AppRepository } from '../../database/repositories.js';

const identifierParametersSchema = z.object({ id: z.string().min(1) });
const projectCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(4000).optional(),
    rootPath: z.string().trim().min(1),
  })
  .strict();
const projectUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(4000).nullable().optional(),
    rootPath: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: 'At least one project field must be provided.',
  });

export function registerProjectRoutes(server: FastifyInstance, repository: AppRepository): void {
  server.get('/api/v1/projects', async () => repository.listProjects());

  server.post('/api/v1/projects', async (request, reply) => {
    const input = projectCreateSchema.parse(request.body);
    const project = await repository.createProject({
      name: input.name,
      rootPath: resolve(input.rootPath),
      ...(input.description === undefined ? {} : { description: input.description }),
    });
    return reply.status(201).send(project);
  });

  server.get('/api/v1/projects/:id', async (request, reply) => {
    const { id } = identifierParametersSchema.parse(request.params);
    const project = await repository.getProject(id);
    return project ?? notFound(reply, 'Project');
  });

  server.patch('/api/v1/projects/:id', async (request, reply) => {
    const { id } = identifierParametersSchema.parse(request.params);
    const input = projectUpdateSchema.parse(request.body);
    const project = await repository.updateProject(id, {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.rootPath === undefined ? {} : { rootPath: resolve(input.rootPath) }),
    });
    return project ?? notFound(reply, 'Project');
  });

  server.delete('/api/v1/projects/:id', async (request, reply) => {
    const { id } = identifierParametersSchema.parse(request.params);
    if (!(await repository.deleteProject(id))) return notFound(reply, 'Project');
    return reply.status(204).send();
  });
}

function notFound(reply: FastifyReply, type: string) {
  return reply.status(404).send({ error: { code: 'NOT_FOUND', message: `${type} not found.` } });
}
