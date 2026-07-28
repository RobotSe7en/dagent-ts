import { runIdSchema } from 'dagent-ai/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  onlyOfficeConfigSchema,
  type OnlyOfficeService,
} from '../../services/onlyoffice-service.js';

const ownerParametersSchema = z.object({ id: z.string().min(1) });
const runParametersSchema = z.object({ id: runIdSchema });
const tokenParametersSchema = z.object({ token: z.string().min(1) });
const pathQuerySchema = z.object({ path: z.string().trim().min(1) });
const updateSchema = z
  .object({
    config: onlyOfficeConfigSchema,
    secretAction: z.enum(['preserve', 'replace', 'clear']).default('preserve'),
  })
  .strict()
  .refine((input) => input.secretAction !== 'replace' || input.config.jwtSecret !== undefined, {
    message: 'jwtSecret is required when secretAction is replace.',
    path: ['config', 'jwtSecret'],
  });
const callbackSchema = z
  .object({
    status: z.number().int(),
    url: z.url().optional(),
  })
  .loose();

export function registerOnlyOfficeRoutes(
  server: FastifyInstance,
  onlyOffice: OnlyOfficeService,
): void {
  server.get('/api/v1/system/onlyoffice', async () => onlyOffice.settings());

  server.put('/api/v1/system/onlyoffice', async (request) => {
    const input = updateSchema.parse(request.body);
    return onlyOffice.update(input.config, input.secretAction);
  });

  server.get('/api/v1/projects/:id/files/onlyoffice/config', async (request) => {
    const { id } = ownerParametersSchema.parse(request.params);
    const { path } = pathQuerySchema.parse(request.query);
    return onlyOffice.projectConfig(id, path);
  });

  server.get('/api/v1/runs/:id/artifacts/onlyoffice/config', async (request) => {
    const { id } = runParametersSchema.parse(request.params);
    const { path } = pathQuerySchema.parse(request.query);
    return onlyOffice.runConfig(id, path);
  });

  server.get('/api/v1/onlyoffice/files/:token', async (request, reply) => {
    const { token } = tokenParametersSchema.parse(request.params);
    const file = await onlyOffice.file(token);
    return reply
      .header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`)
      .type(file.mediaType)
      .send(Buffer.from(file.content));
  });

  server.post('/api/v1/onlyoffice/callback/:token', async (request) => {
    const { token } = tokenParametersSchema.parse(request.params);
    const input = callbackSchema.parse(request.body);
    return onlyOffice.callback(token, {
      status: input.status,
      ...(input.url === undefined ? {} : { url: input.url }),
    });
  });
}
