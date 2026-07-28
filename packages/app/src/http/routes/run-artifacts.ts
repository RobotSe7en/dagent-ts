import { runIdSchema } from 'dagent-ai/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { attachmentHeader } from '../../services/file-metadata.js';
import type { RunArtifactService } from '../../services/run-artifact-service.js';

const runParametersSchema = z.object({ id: runIdSchema });
const artifactQuerySchema = z.object({ path: z.string().trim().min(1) });

export function registerRunArtifactRoutes(
  server: FastifyInstance,
  artifacts: RunArtifactService,
): void {
  server.get('/api/v1/runs/:id/artifacts', async (request) => {
    const { id } = runParametersSchema.parse(request.params);
    return artifacts.list(id);
  });

  server.get('/api/v1/runs/:id/artifacts/preview', async (request) => {
    const { id } = runParametersSchema.parse(request.params);
    const { path } = artifactQuerySchema.parse(request.query);
    return artifacts.preview(id, path);
  });

  server.get('/api/v1/runs/:id/artifacts/download', async (request, reply) => {
    const { id } = runParametersSchema.parse(request.params);
    const { path } = artifactQuerySchema.parse(request.query);
    const file = await artifacts.download(id, path);
    return reply
      .header('Content-Disposition', attachmentHeader(file.name))
      .type(file.mediaType)
      .send(Buffer.from(file.content));
  });
}
