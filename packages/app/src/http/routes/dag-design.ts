import { assertValidDag, type DagAgent, type DagDesignEvent, type Runner } from 'dagent-ai';
import { dagDesignSelectionSchema, dagSpecSchema } from 'dagent-ai/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const inspectSchema = z.object({ graph: dagSpecSchema }).strict();
const designSchema = z
  .object({
    instruction: z.string().trim().min(1),
    agentId: z.string().min(1).optional(),
    current: dagSpecSchema.optional(),
    selection: dagDesignSelectionSchema.optional(),
  })
  .strict();

export function registerDagDesignRoutes(server: FastifyInstance, runner: Runner): void {
  server.post('/api/v1/dags/validate', async (request) => ({
    graph: assertValidDag(request.body),
  }));

  server.post('/api/v1/dags/inspect', async (request) => {
    const { graph } = inspectSchema.parse(request.body);
    return { diagnostics: runner.inspectDag(graph) };
  });

  server.post('/api/v1/dags/design', async (request) => {
    const input = designSchema.parse(request.body);
    let agent: DagAgent | undefined;
    if (input.agentId !== undefined) {
      const selected = runner.agent(input.agentId);
      if (selected?.kind !== 'dag-agent') {
        throw new TypeError(`DAG design agent '${input.agentId}' is not registered.`);
      }
      agent = selected;
    }
    const events: DagDesignEvent[] = [];
    const result = await runner.designDag(input.instruction, {
      ...(agent === undefined ? {} : { agent }),
      ...(input.current === undefined ? {} : { current: input.current }),
      ...(input.selection === undefined ? {} : { selection: input.selection }),
      onEvent(event) {
        events.push(event);
      },
    });
    return { result, events };
  });
}
