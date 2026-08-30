import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import type { AppRepository, Conversation, ConversationKind } from '../../database/repositories.js';
import { publicConversation, publicConversationSummary } from '../public-conversation.js';
import { publicRunSummary } from '../public-run.js';

const conversationKindSchema = z.enum(['chat', 'dynamic-dag', 'static-dag']);
const identifierParametersSchema = z.object({ id: z.string().min(1) });
const scopedParametersSchema = z.object({
  projectId: z.string().min(1),
  conversationId: z.string().min(1),
});
const conversationListSchema = z.object({ projectId: z.string().min(1).optional() });
const conversationCreateSchema = z
  .object({
    projectId: z.string().min(1).optional(),
    title: z.string().trim().min(1).max(300),
    kind: conversationKindSchema.default('chat'),
    workspaceScope: z.enum(['project', 'standalone']).optional(),
  })
  .strict();
const scopedConversationCreateSchema = conversationCreateSchema.omit({
  projectId: true,
  workspaceScope: true,
});
const conversationUpdateSchema = z.object({ title: z.string().trim().min(1).max(300) }).strict();

export function registerConversationRoutes(
  server: FastifyInstance,
  repository: AppRepository,
): void {
  server.get('/api/v1/conversations', async (request) => {
    const { projectId } = conversationListSchema.parse(request.query);
    const conversations =
      projectId === undefined
        ? await repository.listAllConversations()
        : await repository.listConversations(projectId);
    return conversations.map(publicConversationSummary);
  });

  server.post('/api/v1/conversations', async (request, reply) => {
    const input = conversationCreateSchema.parse(request.body);
    return createConversation(repository, reply, {
      title: input.title,
      kind: input.kind,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.workspaceScope === undefined ? {} : { workspaceScope: input.workspaceScope }),
    });
  });

  server.get('/api/v1/conversations/:id', async (request, reply) => {
    const { id } = identifierParametersSchema.parse(request.params);
    const conversation = await repository.getConversation(id);
    return conversation === undefined
      ? notFound(reply, 'Conversation')
      : publicConversation(conversation);
  });

  server.patch('/api/v1/conversations/:id', async (request, reply) => {
    const { id } = identifierParametersSchema.parse(request.params);
    const { title } = conversationUpdateSchema.parse(request.body);
    const conversation = await repository.updateConversationTitle(id, title);
    return conversation === undefined
      ? notFound(reply, 'Conversation')
      : publicConversation(conversation);
  });

  server.delete('/api/v1/conversations/:id', async (request, reply) => {
    const { id } = identifierParametersSchema.parse(request.params);
    if (!(await repository.deleteConversation(id))) return notFound(reply, 'Conversation');
    return reply.status(204).send();
  });

  server.get('/api/v1/conversations/:id/messages', async (request, reply) => {
    const { id } = identifierParametersSchema.parse(request.params);
    const conversation = await repository.getConversation(id);
    return conversation === undefined
      ? notFound(reply, 'Conversation')
      : { messages: publicConversation(conversation).conversation.items };
  });

  server.get('/api/v1/conversations/:id/runs', async (request, reply) => {
    const { id } = identifierParametersSchema.parse(request.params);
    if ((await repository.getConversation(id)) === undefined) {
      return notFound(reply, 'Conversation');
    }
    return {
      runs: (await repository.listRuns({ conversationId: id })).map(publicRunSummary),
    };
  });

  server.get('/api/v1/projects/:id/conversations', async (request, reply) => {
    const { id } = identifierParametersSchema.parse(request.params);
    if ((await repository.getProject(id)) === undefined) return notFound(reply, 'Project');
    return (await repository.listConversations(id)).map(publicConversationSummary);
  });

  server.post('/api/v1/projects/:id/conversations', async (request, reply) => {
    const { id } = identifierParametersSchema.parse(request.params);
    const input = scopedConversationCreateSchema.parse(request.body);
    return createConversation(repository, reply, {
      ...input,
      projectId: id,
      workspaceScope: 'project',
    });
  });

  server.get(
    '/api/v1/projects/:projectId/conversations/:conversationId',
    async (request, reply) => {
      const identifiers = scopedParametersSchema.parse(request.params);
      const conversation = await projectConversation(repository, identifiers);
      return conversation === undefined
        ? notFound(reply, 'Conversation')
        : publicConversation(conversation);
    },
  );

  server.patch(
    '/api/v1/projects/:projectId/conversations/:conversationId',
    async (request, reply) => {
      const identifiers = scopedParametersSchema.parse(request.params);
      if ((await projectConversation(repository, identifiers)) === undefined) {
        return notFound(reply, 'Conversation');
      }
      const { title } = conversationUpdateSchema.parse(request.body);
      const conversation = await repository.updateConversationTitle(
        identifiers.conversationId,
        title,
      );
      return conversation === undefined
        ? notFound(reply, 'Conversation')
        : publicConversation(conversation);
    },
  );

  server.delete(
    '/api/v1/projects/:projectId/conversations/:conversationId',
    async (request, reply) => {
      const identifiers = scopedParametersSchema.parse(request.params);
      if ((await projectConversation(repository, identifiers)) === undefined) {
        return notFound(reply, 'Conversation');
      }
      await repository.deleteConversation(identifiers.conversationId);
      return reply.status(204).send();
    },
  );

  server.get(
    '/api/v1/projects/:projectId/conversations/:conversationId/messages',
    async (request, reply) => {
      const identifiers = scopedParametersSchema.parse(request.params);
      const conversation = await projectConversation(repository, identifiers);
      return conversation === undefined
        ? notFound(reply, 'Conversation')
        : { messages: publicConversation(conversation).conversation.items };
    },
  );

  server.get(
    '/api/v1/projects/:projectId/conversations/:conversationId/runs',
    async (request, reply) => {
      const identifiers = scopedParametersSchema.parse(request.params);
      if ((await projectConversation(repository, identifiers)) === undefined) {
        return notFound(reply, 'Conversation');
      }
      return {
        runs: (
          await repository.listRuns({
            projectId: identifiers.projectId,
            conversationId: identifiers.conversationId,
          })
        ).map(publicRunSummary),
      };
    },
  );
}

async function createConversation(
  repository: AppRepository,
  reply: FastifyReply,
  input: {
    readonly projectId?: string;
    readonly title: string;
    readonly kind: ConversationKind;
    readonly workspaceScope?: 'project' | 'standalone';
  },
) {
  if (
    input.projectId !== undefined &&
    (await repository.getProject(input.projectId)) === undefined
  ) {
    return notFound(reply, 'Project');
  }
  return reply.status(201).send(publicConversation(await repository.createConversation(input)));
}

async function projectConversation(
  repository: AppRepository,
  input: { readonly projectId: string; readonly conversationId: string },
): Promise<Conversation | undefined> {
  const conversation = await repository.getConversation(input.conversationId);
  return conversation?.projectId === input.projectId ? conversation : undefined;
}

function notFound(reply: FastifyReply, type: string) {
  return reply.status(404).send({ error: { code: 'NOT_FOUND', message: `${type} not found.` } });
}
