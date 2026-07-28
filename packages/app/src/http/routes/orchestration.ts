import { dagSpecSchema, jsonObjectSchema } from 'dagent-ai/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { OrchestrationRepository } from '../../database/orchestration-repository.js';
import type { AppRepository } from '../../database/repositories.js';
import type { SavedDagRepository } from '../../database/saved-dag-repository.js';
import { publicRunSummary } from '../public-run.js';

const orchestrationKindSchema = z.enum(['tool-agent', 'dag-agent', 'static-dag']);

const createSessionSchema = z
  .object({
    conversationId: z.string().min(1),
    projectId: z.string().min(1),
    kind: orchestrationKindSchema,
    savedDagId: z.string().min(1).optional(),
    draftGraph: dagSpecSchema.optional(),
    uiState: jsonObjectSchema.default({}),
  })
  .strict();

const updateSessionSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    savedDagId: z.string().min(1).nullable().optional(),
    draftGraph: dagSpecSchema.nullable().optional(),
    uiState: jsonObjectSchema.optional(),
  })
  .strict();

const idParameterSchema = z.object({ id: z.string().min(1) });

export function registerOrchestrationRoutes(
  server: FastifyInstance,
  orchestration: OrchestrationRepository,
  repository: AppRepository,
  savedDags: SavedDagRepository,
): void {
  server.post('/api/v1/orchestration-sessions', async (request, reply) => {
    const input = createSessionSchema.parse(request.body);
    const conversation = await repository.getConversation(input.conversationId);
    if (conversation === undefined || conversation.projectId !== input.projectId) {
      return reply
        .status(404)
        .send({ error: { code: 'NOT_FOUND', message: 'Conversation not found in project.' } });
    }
    if (
      input.savedDagId !== undefined &&
      !(await savedDagBelongsToProject(savedDags, input.savedDagId, input.projectId))
    ) {
      return reply
        .status(404)
        .send({ error: { code: 'NOT_FOUND', message: 'Saved DAG not found in project.' } });
    }
    return reply.status(201).send({
      session: await orchestration.create({
        conversationId: input.conversationId,
        projectId: input.projectId,
        kind: input.kind,
        uiState: input.uiState,
        ...(input.savedDagId === undefined ? {} : { savedDagId: input.savedDagId }),
        ...(input.draftGraph === undefined ? {} : { draftGraph: input.draftGraph }),
      }),
    });
  });

  server.get('/api/v1/orchestration-sessions/:id', async (request, reply) => {
    const { id } = idParameterSchema.parse(request.params);
    const session = await orchestration.get(id);
    return session === undefined
      ? reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Orchestration session not found.' } })
      : { session };
  });

  server.get('/api/v1/orchestration-sessions/:id/runs', async (request, reply) => {
    const { id } = idParameterSchema.parse(request.params);
    if ((await orchestration.get(id)) === undefined) {
      return reply
        .status(404)
        .send({ error: { code: 'NOT_FOUND', message: 'Orchestration session not found.' } });
    }
    return {
      runs: (await repository.listRuns({ orchestrationSessionId: id })).map(publicRunSummary),
    };
  });

  server.get('/api/v1/conversations/:id/orchestration-session', async (request, reply) => {
    const { id } = idParameterSchema.parse(request.params);
    const session = await orchestration.getByConversation(id);
    return session === undefined
      ? reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Orchestration session not found.' } })
      : { session };
  });

  server.patch('/api/v1/orchestration-sessions/:id', async (request, reply) => {
    const { id } = idParameterSchema.parse(request.params);
    const input = updateSessionSchema.parse(request.body);
    const existing = await orchestration.get(id);
    if (existing === undefined) {
      return reply
        .status(404)
        .send({ error: { code: 'NOT_FOUND', message: 'Orchestration session not found.' } });
    }
    if (
      input.savedDagId !== undefined &&
      input.savedDagId !== null &&
      !(await savedDagBelongsToProject(savedDags, input.savedDagId, existing.projectId))
    ) {
      return reply
        .status(404)
        .send({ error: { code: 'NOT_FOUND', message: 'Saved DAG not found in project.' } });
    }
    const session = await orchestration.update(id, {
      expectedRevision: input.expectedRevision,
      ...(Object.hasOwn(input, 'savedDagId') && input.savedDagId !== undefined
        ? { savedDagId: input.savedDagId }
        : {}),
      ...(Object.hasOwn(input, 'draftGraph') && input.draftGraph !== undefined
        ? { draftGraph: input.draftGraph }
        : {}),
      ...(input.uiState === undefined ? {} : { uiState: input.uiState }),
    });
    return { session };
  });
}

async function savedDagBelongsToProject(
  savedDags: SavedDagRepository,
  savedDagId: string,
  projectId: string,
): Promise<boolean> {
  const savedDag = await savedDags.get(savedDagId);
  return savedDag?.projectId === projectId;
}
