import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { attachmentHeader } from '../../services/file-metadata.js';
import type { ProjectFileService } from '../../services/project-file-service.js';
import { base64StringSchema, decodeBase64 } from '../base64.js';

const pathParametersSchema = z.object({ id: z.string().min(1) });
const pathQuerySchema = z.object({ path: z.string().default('.') });
const requiredPathSchema = z.string().trim().min(1);
const writeSchema = z
  .object({
    path: requiredPathSchema,
    content: z.string().optional(),
    contentBase64: base64StringSchema.optional(),
    overwrite: z.boolean().default(false),
  })
  .refine(
    (value) =>
      Number(value.content !== undefined) + Number(value.contentBase64 !== undefined) === 1,
    {
      message: 'Exactly one of content or contentBase64 must be provided.',
    },
  );
const directorySchema = z.object({ path: requiredPathSchema });
const moveSchema = z.object({
  source: requiredPathSchema,
  destination: requiredPathSchema,
  overwrite: z.boolean().default(false),
});
const deleteQuerySchema = z.object({
  path: requiredPathSchema,
  recursive: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

export function registerProjectFileRoutes(
  server: FastifyInstance,
  files: ProjectFileService,
): void {
  server.get('/api/v1/projects/:id/files/download', async (request, reply) => {
    const { id } = pathParametersSchema.parse(request.params);
    const { path } = pathQuerySchema.parse(request.query);
    const file = await files.download(id, path);
    return reply
      .header('Content-Disposition', attachmentHeader(file.name))
      .type(file.mediaType)
      .send(Buffer.from(file.content));
  });

  server.get('/api/v1/projects/:id/files', async (request) => {
    const { id } = pathParametersSchema.parse(request.params);
    const { path } = pathQuerySchema.parse(request.query);
    return files.inspect(id, path);
  });

  server.post('/api/v1/projects/:id/files', async (request, reply) => {
    const { id } = pathParametersSchema.parse(request.params);
    const input = writeSchema.parse(request.body);
    const content =
      input.content === undefined ? decodeBase64(input.contentBase64 ?? '') : input.content;
    const entry = await files.write(id, input.path, content, {
      overwrite: input.overwrite,
    });
    return reply.status(201).send({ entry });
  });

  server.post('/api/v1/projects/:id/directories', async (request, reply) => {
    const { id } = pathParametersSchema.parse(request.params);
    const { path } = directorySchema.parse(request.body);
    return reply.status(201).send({ entry: await files.createDirectory(id, path) });
  });

  server.patch('/api/v1/projects/:id/files', async (request) => {
    const { id } = pathParametersSchema.parse(request.params);
    const input = moveSchema.parse(request.body);
    return {
      entry: await files.move(id, input.source, input.destination, {
        overwrite: input.overwrite,
      }),
    };
  });

  server.delete('/api/v1/projects/:id/files', async (request, reply) => {
    const { id } = pathParametersSchema.parse(request.params);
    const input = deleteQuerySchema.parse(request.query);
    await files.delete(id, input.path, { recursive: input.recursive });
    return reply.status(204).send();
  });
}
