import { assertValidDag, defineStaticDag } from 'dagent-ai';
import { dagSpecSchema, jsonObjectSchema } from 'dagent-ai/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { AppRepository } from '../../database/repositories.js';
import type { OrchestrationRepository } from '../../database/orchestration-repository.js';
import type { SavedDagRepository } from '../../database/saved-dag-repository.js';
import type { RunService } from '../../services/run-service.js';
import { publicRunSummary } from '../public-run.js';
import { decodeRunInput, staticRunInputSchema } from '../run-input.js';

const createSavedDagSchema = z
  .object({
    projectId: z.string().min(1).optional(),
    name: z.string().trim().min(1).max(200),
    description: z.string().default(''),
    graph: dagSpecSchema,
    layout: jsonObjectSchema.default({}),
  })
  .strict();

const updateSavedDagSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().optional(),
    graph: dagSpecSchema.optional(),
    layout: jsonObjectSchema.optional(),
  })
  .strict();

const savedDagParameterSchema = z.object({ id: z.string().min(1) });
const savedDagQuerySchema = z.object({ projectId: z.string().min(1).optional() });
const runSavedDagSchema = z
  .object({
    conversationId: z.string().min(1).optional(),
    orchestrationSessionId: z.string().min(1).optional(),
    reviewLevel: z.enum(['never', 'risky', 'always']).default('never'),
    ...staticRunInputSchema.shape,
  })
  .strict();

export function registerSavedDagRoutes(
  server: FastifyInstance,
  savedDags: SavedDagRepository,
  orchestration: OrchestrationRepository,
  repository: AppRepository,
  runs: RunService,
): void {
  server.get('/api/v1/saved-dags', async (request, reply) => {
    const { projectId } = savedDagQuerySchema.parse(request.query);
    if (projectId !== undefined && (await repository.getProject(projectId)) === undefined) {
      return reply
        .status(404)
        .send({ error: { code: 'NOT_FOUND', message: 'Project not found.' } });
    }
    return { savedDags: await savedDags.list(projectId) };
  });

  server.post('/api/v1/saved-dags', async (request, reply) => {
    const input = createSavedDagSchema.parse(request.body);
    if (
      input.projectId !== undefined &&
      (await repository.getProject(input.projectId)) === undefined
    ) {
      return reply
        .status(404)
        .send({ error: { code: 'NOT_FOUND', message: 'Project not found.' } });
    }
    const graph = assertValidDag(input.graph);
    return reply.status(201).send({
      savedDag: await savedDags.create({
        name: input.name,
        description: input.description,
        graph,
        layout: input.layout,
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      }),
    });
  });

  server.get('/api/v1/saved-dags/:id', async (request, reply) => {
    const { id } = savedDagParameterSchema.parse(request.params);
    const savedDag = await savedDags.get(id);
    return savedDag === undefined
      ? reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Saved DAG not found.' } })
      : { savedDag };
  });

  server.get('/api/v1/saved-dags/:id/runs', async (request, reply) => {
    const { id } = savedDagParameterSchema.parse(request.params);
    if ((await savedDags.get(id)) === undefined) {
      return reply
        .status(404)
        .send({ error: { code: 'NOT_FOUND', message: 'Saved DAG not found.' } });
    }
    return {
      runs: (await repository.listRuns({ savedDagId: id })).map(publicRunSummary),
    };
  });

  server.post('/api/v1/saved-dags/:id/runs', async (request, reply) => {
    const { id } = savedDagParameterSchema.parse(request.params);
    const input = runSavedDagSchema.parse(request.body);
    const savedDag = await savedDags.get(id);
    if (savedDag === undefined) {
      return reply
        .status(404)
        .send({ error: { code: 'NOT_FOUND', message: 'Saved DAG not found.' } });
    }
    if (input.conversationId !== undefined) {
      const conversation = await repository.getConversation(input.conversationId);
      if (
        conversation === undefined ||
        (savedDag.projectId !== undefined && conversation.projectId !== savedDag.projectId)
      ) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'Conversation not found in DAG project.' },
        });
      }
    }
    if (input.orchestrationSessionId !== undefined) {
      const session = await orchestration.get(input.orchestrationSessionId);
      if (
        session === undefined ||
        session.savedDagId !== savedDag.id ||
        (savedDag.projectId !== undefined && session.projectId !== savedDag.projectId) ||
        (input.conversationId !== undefined && session.conversationId !== input.conversationId)
      ) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Orchestration session not found for this saved DAG.',
          },
        });
      }
    }
    const runId = await runs.start({
      target: defineStaticDag(savedDag.graph, input.reviewLevel),
      runInput: decodeRunInput(input),
      savedDagId: savedDag.id,
      ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
      ...(input.orchestrationSessionId === undefined
        ? {}
        : { orchestrationSessionId: input.orchestrationSessionId }),
    });
    return reply.status(202).send({ runId });
  });

  server.patch('/api/v1/saved-dags/:id', async (request, reply) => {
    const { id } = savedDagParameterSchema.parse(request.params);
    const input = updateSavedDagSchema.parse(request.body);
    const savedDag = await savedDags.update(id, {
      expectedRevision: input.expectedRevision,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.layout === undefined ? {} : { layout: input.layout }),
      ...(input.graph === undefined ? {} : { graph: assertValidDag(input.graph) }),
    });
    return savedDag === undefined
      ? reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Saved DAG not found.' } })
      : { savedDag };
  });

  server.delete('/api/v1/saved-dags/:id', async (request, reply) => {
    const { id } = savedDagParameterSchema.parse(request.params);
    return (await savedDags.archive(id))
      ? reply.status(204).send()
      : reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Saved DAG not found.' } });
  });
}
