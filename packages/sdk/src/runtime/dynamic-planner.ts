import { z } from 'zod';

import type {
  ContextSummary,
  ContextUsage,
  ChatMessage,
  ChatResponse,
  ConversationItem,
  ConversationState,
  DagAgent,
  DAGSpec,
  JsonObject,
  PlanProposal,
  Attachment,
} from '../contracts/index.js';
import {
  appendConversationItems,
  assistantMessageSchema,
  contextSummarySchema,
  conversationStateSchema,
  planProposalSchema,
  userMessageSchema,
} from '../contracts/index.js';
import { assertValidDag } from '../domain/dag-validation.js';
import { DagentError, errorMessage } from '../errors.js';
import { composeSystemPrompt, runtimeContextForWorkspace } from '../profiles/prompt-builder.js';
import { ContextAssembler } from './context-assembler.js';
import { withRetry } from './retry.js';
import type { RuntimeExecutionContext } from './types.js';

export type DynamicPlanInput = {
  readonly prompt: string;
  readonly conversation?: ConversationState;
  readonly previousGraph?: DAGSpec;
  readonly failure?: string;
  readonly completedNodeIds?: readonly string[];
  readonly attachments?: readonly Attachment[];
};

export type DynamicPlanResult = {
  readonly proposal: PlanProposal;
  readonly conversation: ConversationState;
  readonly contextUsage: readonly ContextUsage[];
};

export class DynamicPlanner {
  public async plan(
    agent: DagAgent,
    input: DynamicPlanInput,
    context: RuntimeExecutionContext,
  ): Promise<DynamicPlanResult> {
    const baseConversation = conversationStateSchema.parse(
      input.conversation ?? { schemaVersion: 3 },
    );
    const user = userMessageSchema.parse({
      type: 'user',
      runId: context.runId,
      content: input.prompt,
      attachments: input.attachments ?? [],
    });
    let thread =
      input.previousGraph === undefined
        ? appendConversationItems(baseConversation, user)
        : baseConversation;
    if (input.previousGraph === undefined && !thread.items.some((item) => item.id === user.id)) {
      thread = appendConversationItems(thread, {
        ...user,
        scope: 'conversation',
        visibility: 'user',
      });
    }

    const definitions = context.catalog.definitions(agent.scope.capabilities);
    const systemMessage = {
      role: 'system' as const,
      content: plannerSystemPrompt(
        agent,
        definitions,
        input,
        context.workspacePath,
        context.extraSystemPrompt,
      ),
    };
    const assembler = new ContextAssembler({
      contextWindowTokens: context.contextWindowTokens,
      outputReserveTokens: context.outputReserveTokens,
    });
    const usages: ContextUsage[] = [];
    let compactionStarted = false;
    const prepared = await assembler.prepare({
      systemMessage,
      conversation: thread,
      policy: agent.context,
      compact: async (previous, items, maxTokens) => {
        compactionStarted = true;
        await context.events.emit({
          type: 'context-compaction-started',
          scope: 'planner',
          itemCount: items.length,
        });
        const summary = await compactPlannerHistory(
          previous,
          items,
          maxTokens,
          context,
          assembler,
          agent.context,
        );
        await context.events.emit({
          type: 'context-compaction-finished',
          scope: 'planner',
          itemCount: items.length,
          method: 'model',
        });
        return summary;
      },
    });
    thread = prepared.conversation;
    usages.push(prepared.usage);
    if (compactionStarted && prepared.usage.compactionMethod === 'deterministic-fallback') {
      await context.events.emit({
        type: 'context-compaction-finished',
        scope: 'planner',
        itemCount: prepared.usage.compactedItems,
        method: 'deterministic-fallback',
      });
    }
    await context.events.emit({
      type: 'context-usage',
      scope: 'planner',
      usage: prepared.usage,
    });

    const allowedCapabilities = new Set(definitions.map(({ id }) => id));
    const requestPlan = async (messages: readonly ChatMessage[]): Promise<ChatResponse> => {
      context.budget.reserveModelCall(context.signal);
      return withRetry(
        () =>
          context.provider.chat(
            {
              messages,
              responseFormat: {
                name: 'dag_plan',
                description: 'A canonical, bounded DAG plan.',
                schema: z.toJSONSchema(planProposalSchema),
                strict: true,
              },
            },
            { signal: context.signal },
          ),
        { signal: context.signal },
      );
    };
    let response = await requestPlan(prepared.messages);
    let proposal: PlanProposal;
    try {
      proposal = validateProposal(parseJsonObject(response.content), allowedCapabilities, input);
    } catch (firstError) {
      response = await requestPlan([
        ...prepared.messages,
        {
          role: 'assistant',
          content: response.content.slice(0, 100_000),
        },
        {
          role: 'user',
          content:
            `The proposed plan failed validation: ${errorMessage(firstError)} ` +
            'Repair it and return one complete object matching the supplied schema. ' +
            'Do not explain the repair.',
        },
      ]);
      try {
        proposal = validateProposal(parseJsonObject(response.content), allowedCapabilities, input);
      } catch (repairError) {
        throw new DagentError(
          'PROVIDER_FAILED',
          `Planner returned an invalid plan after one schema repair: ${errorMessage(repairError)}`,
          { cause: repairError },
        );
      }
    }
    const assistant = assistantMessageSchema.parse({
      type: 'assistant',
      runId: context.runId,
      content: JSON.stringify(proposal),
      reasoning: response.reasoningContent,
      refusal: response.refusal,
      ...(response.usage === undefined ? {} : { usage: response.usage }),
      scope: 'planner',
      visibility: 'internal',
    });
    thread = appendConversationItems(thread, assistant);
    await context.events.emit({ type: 'plan-proposed', graph: proposal.graph });
    return {
      proposal,
      conversation: thread,
      contextUsage: usages,
    };
  }
}

function plannerSystemPrompt(
  agent: DagAgent,
  definitions: readonly { readonly id: string; readonly description: string }[],
  input: DynamicPlanInput,
  workspacePath: string,
  extraSystemPrompt: string | undefined,
): string {
  const capabilityLines = definitions.map(
    (definition) => `- ${definition.id}: ${definition.description}`,
  );
  const replan =
    input.previousGraph === undefined
      ? ''
      : `\nThis is a replan. Previous graph:\n${JSON.stringify(input.previousGraph)}\nFailure: ${
          input.failure ?? 'unspecified'
        }\nCompleted nodes that must not be changed: ${JSON.stringify(
          input.completedNodeIds ?? [],
        )}`;
  return composeSystemPrompt(agent.systemPrompt, {
    runtimeContext: runtimeContextForWorkspace(workspacePath),
    ...(extraSystemPrompt === undefined ? {} : { extraSystemPrompt }),
    dynamicSections: [
      `Create a canonical DAGSpec that solves the user's request. Use only listed capability ids.
Every node-output reference must have an explicit upstream edge. Use bounded map, subgraph,
or loop nodes for control flow. Never output source code. Return only the structured object
matching the supplied JSON Schema.

Capabilities:
${capabilityLines.join('\n')}${replan}`,
    ],
  });
}

function validateProposal(
  value: JsonObject,
  allowedCapabilities: ReadonlySet<string>,
  input: DynamicPlanInput,
): PlanProposal {
  const parsed = planProposalSchema.parse(value);
  const graph = assertValidDag(parsed.graph);
  for (const capabilityId of graphCapabilityIds(graph)) {
    if (!allowedCapabilities.has(capabilityId)) {
      throw new DagentError(
        'DAG_VALIDATION_FAILED',
        `Planner selected unavailable capability '${capabilityId}'.`,
      );
    }
  }
  if (input.previousGraph !== undefined) {
    const oldNodes = new Map(input.previousGraph.nodes.map((node) => [node.id, node]));
    const newNodes = new Map(graph.nodes.map((node) => [node.id, node]));
    for (const nodeId of input.completedNodeIds ?? []) {
      if (JSON.stringify(oldNodes.get(nodeId)) !== JSON.stringify(newNodes.get(nodeId))) {
        throw new DagentError(
          'DAG_VALIDATION_FAILED',
          `Replan changed protected completed node '${nodeId}'.`,
        );
      }
    }
  }
  return planProposalSchema.parse({ ...parsed, graph });
}

function graphCapabilityIds(graph: DAGSpec): string[] {
  return graph.nodes.flatMap((node) => {
    if (node.kind === 'capability') return [node.capabilityId];
    if (node.kind === 'agent') return [];
    return graphCapabilityIds(node.graph);
  });
}

function parseJsonObject(content: string): JsonObject {
  const normalized = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    const value: unknown = JSON.parse(normalized);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return value as JsonObject;
    }
  } catch {
    // Converted to the stable domain error below.
  }
  throw new DagentError('PROVIDER_FAILED', 'Planner returned invalid JSON.');
}

async function compactPlannerHistory(
  previous: ContextSummary | undefined,
  items: readonly ConversationItem[],
  maxTokens: number,
  context: RuntimeExecutionContext,
  assembler: ContextAssembler,
  policy: DagAgent['context'],
): Promise<ContextSummary> {
  const sourceText = [
    previous?.content,
    ...items.map((item) =>
      item.type === 'tool-result'
        ? `Tool ${item.capabilityId ?? item.name}: ${item.status}`
        : `${item.type}: ${item.content}`,
    ),
  ]
    .filter((value): value is string => value !== undefined)
    .join('\n\n');
  const [source, sourceTruncated] = assembler.truncateText(
    sourceText,
    Math.max(1, Math.floor((context.contextWindowTokens - context.outputReserveTokens) * 0.7)),
  );
  const systemMessage: ChatMessage = {
    role: 'system',
    content:
      'Summarize earlier planner data for continuation. Preserve requirements, accepted plan constraints, observations, failures, and unresolved work. Never include hidden reasoning.',
  };
  const prepared = await assembler.prepare({
    systemMessage,
    conversation: conversationStateSchema.parse({
      schemaVersion: 3,
      items: [
        userMessageSchema.parse({
          type: 'user',
          content: source,
          scope: 'compactor',
          visibility: 'internal',
        }),
      ],
    }),
    policy,
  });
  context.budget.reserveModelCall(context.signal);
  const response = await context.provider.chat(
    { messages: prepared.messages },
    { signal: context.signal },
  );
  const rawContent = response.content.trim();
  if (rawContent.length === 0) {
    throw new Error('Planner compactor returned an empty summary.');
  }
  const [content, outputTruncated] = assembler.truncateText(rawContent, maxTokens);
  return contextSummarySchema.parse({
    content,
    sourceItemCount: (previous?.sourceItemCount ?? 0) + items.length,
    method: 'model',
    sourceTruncated,
    outputTruncated,
    reasoning: response.reasoningContent,
    ...(response.usage === undefined ? {} : { usage: response.usage }),
    contextUsage: prepared.usage,
  });
}
