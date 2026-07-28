import type { RunEvent } from 'dagent-ai';
import { reviewDecisionSchema, runIdSchema, runTargetSchema } from 'dagent-ai/contracts';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import type { AppRepository } from '../../database/repositories.js';
import type { RunService } from '../../services/run-service.js';
import { decodeRunInput, runInputSchema } from '../run-input.js';
import { publicRun, publicRunEvent, publicRunSummary, publicRunTrace } from '../public-run.js';

const startRunSchema = z
  .object({
    conversationId: z.string().min(1).optional(),
    target: runTargetSchema,
    input: runInputSchema,
  })
  .strict();
const runParametersSchema = z.object({ id: runIdSchema });
const runListSchema = z.object({
  projectId: z.string().min(1).optional(),
  conversationId: z.string().min(1).optional(),
  savedDagId: z.string().min(1).optional(),
  orchestrationSessionId: z.string().min(1).optional(),
});
const eventLogSchema = z.object({
  after: z.coerce.number().int().nonnegative().default(0),
});

export function registerRunRoutes(
  server: FastifyInstance,
  repository: AppRepository,
  runs: RunService,
): void {
  server.get('/api/v1/runs', async (request) => {
    const filters = runListSchema.parse(request.query);
    return {
      runs: (
        await repository.listRuns({
          ...(filters.projectId === undefined ? {} : { projectId: filters.projectId }),
          ...(filters.conversationId === undefined
            ? {}
            : { conversationId: filters.conversationId }),
          ...(filters.savedDagId === undefined ? {} : { savedDagId: filters.savedDagId }),
          ...(filters.orchestrationSessionId === undefined
            ? {}
            : { orchestrationSessionId: filters.orchestrationSessionId }),
        })
      ).map(publicRunSummary),
    };
  });

  server.post('/api/v1/runs', async (request, reply) => {
    const input = startRunSchema.parse(request.body);
    if (
      input.conversationId !== undefined &&
      (await repository.getConversation(input.conversationId)) === undefined
    ) {
      return notFound(reply, 'Conversation');
    }
    const runId = await runs.start({
      ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
      target: input.target,
      runInput: decodeRunInput(input.input),
    });
    return reply.status(202).send({ runId });
  });

  server.get('/api/v1/runs/:id', async (request, reply) => {
    const { id } = runParametersSchema.parse(request.params);
    const run = await repository.getRun(id);
    return run === undefined ? notFound(reply, 'Run') : publicRun(run);
  });

  server.delete('/api/v1/runs/:id', async (request, reply) => {
    const { id } = runParametersSchema.parse(request.params);
    const run = await repository.getRun(id);
    if (run === undefined) return notFound(reply, 'Run');
    if (run.status === 'running' || run.status === 'pending' || run.status === 'planning') {
      return reply.status(409).send({
        error: { code: 'RUN_ACTIVE', message: 'An active run cannot be deleted.' },
      });
    }
    await repository.deleteRun(id);
    return reply.status(204).send();
  });

  server.post('/api/v1/runs/:id/cancel', async (request, reply) => {
    const { id } = runParametersSchema.parse(request.params);
    if ((await repository.getRun(id)) === undefined) return notFound(reply, 'Run');
    const cancelled = runs.cancel(id);
    return reply.status(cancelled ? 202 : 409).send({
      runId: id,
      cancelled,
      status: cancelled ? 'cancelling' : 'not-running',
    });
  });

  server.post('/api/v1/runs/:id/reviews', async (request, reply) => {
    const { id } = runParametersSchema.parse(request.params);
    const run = await repository.getRun(id);
    if (run === undefined) return notFound(reply, 'Run');
    if (run.status !== 'awaiting-review' || run.checkpoint?.state.pendingReview === undefined) {
      return reply.status(409).send({
        error: { code: 'RUN_NOT_AWAITING_REVIEW', message: 'Run is not awaiting review.' },
      });
    }
    const decision = reviewDecisionSchema.parse(request.body);
    await runs.resume(id, decision);
    return reply.status(202).send({ runId: id });
  });

  server.get('/api/v1/runs/:id/event-log', async (request, reply) => {
    const { id } = runParametersSchema.parse(request.params);
    const { after } = eventLogSchema.parse(request.query);
    if ((await repository.getRun(id)) === undefined) return notFound(reply, 'Run');
    return {
      events: (await runs.eventsAfter(id, after))
        .map(publicRunEvent)
        .filter((event) => event !== undefined),
    };
  });

  server.get('/api/v1/runs/:id/trace', async (request, reply) => {
    const { id } = runParametersSchema.parse(request.params);
    const run = await repository.getRun(id);
    if (run === undefined) return notFound(reply, 'Run');
    return { trace: publicRunTrace(run, await runs.eventsAfter(id, 0)) };
  });

  server.get('/api/v1/runs/:id/events', async (request, reply) => {
    const { id } = runParametersSchema.parse(request.params);
    if ((await repository.getRun(id)) === undefined) return notFound(reply, 'Run');
    const header = request.headers['last-event-id'];
    const after = typeof header === 'string' ? Number.parseInt(header, 10) || 0 : 0;
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    let lastSent = after;
    const send = (event: RunEvent): void => {
      if (event.sequence <= lastSent || reply.raw.destroyed) return;
      lastSent = event.sequence;
      const visible = publicRunEvent(event);
      if (visible !== undefined) reply.raw.write(serializeServerEvent(event, visible));
    };
    const unsubscribe = runs.on(id, send);
    for (const event of await runs.eventsAfter(id, after)) send(event);
    const heartbeat = setInterval(() => {
      if (!reply.raw.destroyed) reply.raw.write(': heartbeat\n\n');
    }, 15_000);
    heartbeat.unref();
    request.raw.once('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}

function serializeServerEvent(event: RunEvent, payload: unknown): string {
  return `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function notFound(reply: FastifyReply, type: string) {
  return reply.status(404).send({ error: { code: 'NOT_FOUND', message: `${type} not found.` } });
}
