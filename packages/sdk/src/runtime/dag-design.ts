import { z } from 'zod';

import type { CapabilityCatalog } from '../capabilities/catalog.js';
import type {
  ConversationState,
  DAGSpec,
  DagAgent,
  DagDesignEvent,
  DagDesignResult,
  DagDesignSelection,
  DagDiagnostic,
  ToolAgent,
} from '../contracts/index.js';
import {
  appendConversationItems,
  assistantMessageSchema,
  conversationStateSchema,
  dagDesignEventSchema,
  dagDesignResultSchema,
  dagDesignSelectionSchema,
  dagSpecSchema,
  nowTimestamp,
  userMessageSchema,
} from '../contracts/index.js';
import { validateDag } from '../domain/dag-validation.js';
import { graphAgentIds, graphCapabilityIds } from '../domain/dag-transition.js';
import { errorMessage } from '../errors.js';
import type { ChatProvider } from '../providers/provider.js';
import { composeSystemPrompt } from '../profiles/prompt-builder.js';
import { ContextAssembler } from './context-assembler.js';

const designResponseSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('propose'),
      candidate: dagSpecSchema,
      summary: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      action: z.literal('no-change'),
      summary: z.string().trim().min(1),
    })
    .strict(),
  z.object({ action: z.literal('answer'), answer: z.string().trim().min(1) }).strict(),
]);

export type DesignDagRuntimeOptions = {
  readonly provider: ChatProvider;
  readonly catalog: CapabilityCatalog;
  readonly registeredAgents: ReadonlyMap<string, ToolAgent>;
  readonly agent: DagAgent;
  readonly instruction: string;
  readonly current?: DAGSpec;
  readonly selection?: DagDesignSelection;
  readonly conversation?: ConversationState;
  readonly signal?: AbortSignal;
  readonly contextWindowTokens: number;
  readonly outputReserveTokens: number;
  readonly extraSystemPrompt?: string;
  readonly onEvent?: (event: DagDesignEvent) => void | Promise<void>;
};

export async function designDagRuntime(options: DesignDagRuntimeOptions): Promise<DagDesignResult> {
  const instruction = options.instruction.trim();
  if (instruction.length === 0) throw new TypeError('instruction must be a non-empty string.');
  const conversation = conversationStateSchema.parse(options.conversation ?? { schemaVersion: 3 });
  const selection = dagDesignSelectionSchema.parse(options.selection ?? {});
  const selectionDiagnostic = inspectSelection(options.current, selection);
  if (selectionDiagnostic !== undefined) {
    return dagDesignResultSchema.parse({
      type: 'failure',
      diagnostics: [selectionDiagnostic],
      conversation,
    });
  }

  const capabilities = options.catalog
    .definitions(options.agent.scope.capabilities)
    .filter(({ enabled }) => enabled);
  const availableAgents = options.agent.scope.agents.map((id) => {
    const agent = options.registeredAgents.get(id);
    if (agent === undefined) throw new TypeError(`DAG designer agent '${id}' is not registered.`);
    return agent;
  });
  const user = userMessageSchema.parse({
    type: 'user',
    content: instruction,
    scope: 'planner',
    visibility: 'user',
  });
  const pendingConversation = appendConversationItems(conversation, user);
  const assembler = new ContextAssembler({
    contextWindowTokens: options.contextWindowTokens,
    outputReserveTokens: options.outputReserveTokens,
  });
  const prepared = await assembler.prepare({
    systemMessage: {
      role: 'system',
      content: designSystemPrompt(options, capabilities, availableAgents),
    },
    conversation: pendingConversation,
    policy: options.agent.context,
  });
  const emit = designEventEmitter(options.onEvent);
  const request = {
    messages: prepared.messages,
    responseFormat: {
      name: 'dag_design',
      description: 'One non-executing DAG design result.',
      schema: z.toJSONSchema(designResponseSchema),
      strict: true,
    },
  } as const;
  const requestOptions = options.signal === undefined ? undefined : { signal: options.signal };
  let content = '';
  let reasoning = '';
  let response: Awaited<ReturnType<ChatProvider['chat']>> | undefined;
  if (options.onEvent === undefined) {
    response = await options.provider.chat(request, requestOptions);
    content = response.content;
    reasoning = response.reasoningContent;
  } else {
    const responseId = `response_${crypto.randomUUID()}`;
    await emit({ type: 'response-started', responseId });
    for await (const event of options.provider.streamChat(request, requestOptions)) {
      if (event.type === 'token') {
        if (event.channel === 'reasoning') {
          reasoning += event.content;
          await emit({ type: 'reasoning-delta', responseId, delta: event.content });
        } else {
          content += event.content;
        }
      } else {
        response = event.response;
      }
    }
    await emit({ type: 'response-finished', responseId });
    await emit({ type: 'validation-started' });
  }
  if (response === undefined) {
    throw new TypeError('Provider stream finished without a response.');
  }
  if (content.length === 0) content = response.content;
  if (reasoning.length === 0) reasoning = response.reasoningContent;

  const common = (visibleContent: string) => ({
    conversation: appendConversationItems(
      prepared.conversation,
      assistantMessageSchema.parse({
        type: 'assistant',
        content: visibleContent,
        reasoning,
        refusal: response?.refusal ?? '',
        ...(response?.usage === undefined ? {} : { usage: response.usage }),
        scope: 'planner',
        visibility: 'user',
      }),
    ),
    ...(response.usage === undefined ? {} : { usage: response.usage }),
    contextUsage: prepared.usage,
  });
  const failure = (diagnostics: readonly DagDiagnostic[]): DagDesignResult =>
    dagDesignResultSchema.parse({
      type: 'failure',
      diagnostics,
      ...common(`I couldn't complete the DAG design. See diagnostic ${diagnostics[0]?.code}.`),
    });

  if (response.refusal.trim().length > 0) {
    return failure([
      diagnostic('dag-design.model-refusal', `DAG designer refused: ${response.refusal}`),
    ]);
  }
  let designResponse: z.infer<typeof designResponseSchema>;
  try {
    designResponse = designResponseSchema.parse(JSON.parse(stripJsonFence(content)) as unknown);
  } catch (error) {
    return failure([
      diagnostic(
        'dag-design.invalid-model-output',
        `Invalid DAG design response: ${errorMessage(error)}`,
      ),
    ]);
  }

  if (designResponse.action === 'answer') {
    const diagnostics = inspectCurrent(options.current, capabilities, availableAgents);
    if (diagnostics.length === 0) {
      await emit({ type: 'validation-passed', summary: 'DAG design response is valid.' });
    }
    return dagDesignResultSchema.parse({
      type: 'answer',
      answer: designResponse.answer,
      diagnostics,
      ...common(designResponse.answer),
    });
  }
  if (designResponse.action === 'no-change') {
    if (options.current === undefined) {
      return failure([
        diagnostic(
          'dag-design.no-current-dag',
          'The designer returned no-change without a current DAG.',
        ),
      ]);
    }
    const diagnostics = inspectCurrent(options.current, capabilities, availableAgents);
    if (diagnostics.length > 0) return failure(diagnostics);
    await emit({ type: 'validation-passed', summary: 'DAG design response is valid.' });
    return dagDesignResultSchema.parse({
      type: 'no-change',
      summary: designResponse.summary,
      ...common(designResponse.summary),
    });
  }

  const candidate = dagSpecSchema.parse({
    ...designResponse.candidate,
    ...(options.current === undefined ? {} : { id: options.current.id }),
  });
  const diagnostics = inspectCurrent(candidate, capabilities, availableAgents);
  if (diagnostics.length > 0) return failure(diagnostics);
  await emit({ type: 'validation-passed', summary: 'DAG design response is valid.' });
  return dagDesignResultSchema.parse({
    type: 'proposal',
    candidate,
    summary: designResponse.summary,
    diagnostics: [],
    ...common(designResponse.summary),
  });
}

export function inspectDag(spec: DAGSpec): readonly DagDiagnostic[] {
  const validated = validateDag(spec);
  if (validated.valid) return [];
  return validated.issues.map((issue) => {
    const path = issue.path
      .split('.')
      .filter((part) => part.length > 0)
      .map((part) => (/^\d+$/u.test(part) ? Number(part) : part));
    const nodeIndex = path[0] === 'nodes' && typeof path[1] === 'number' ? path[1] : undefined;
    const nodeId = nodeIndex === undefined ? undefined : spec.nodes[nodeIndex]?.id;
    return diagnostic(`dag.${issue.code}`, issue.message, path, nodeId);
  });
}

function inspectCurrent(
  spec: DAGSpec | undefined,
  capabilities: readonly { readonly id: string }[],
  agents: readonly ToolAgent[],
): readonly DagDiagnostic[] {
  if (spec === undefined) return [];
  const diagnostics = inspectDag(spec);
  if (diagnostics.length > 0) return diagnostics;
  const capabilityIds = new Set(capabilities.map(({ id }) => id));
  for (const capabilityId of graphCapabilityIds(spec)) {
    if (!capabilityIds.has(capabilityId)) {
      return [
        diagnostic(
          'dag-design.capability-unavailable',
          `DAG references unavailable capability '${capabilityId}'.`,
        ),
      ];
    }
  }
  const agentIds = new Set(agents.map(({ id }) => id));
  for (const agentId of graphAgentIds(spec)) {
    if (!agentIds.has(agentId)) {
      return [
        diagnostic(
          'dag-design.agent-unavailable',
          `DAG references unavailable agent '${agentId}'.`,
        ),
      ];
    }
  }
  return [];
}

function inspectSelection(
  current: DAGSpec | undefined,
  selection: DagDesignSelection,
): DagDiagnostic | undefined {
  if (selection.nodeIds.length === 0) return undefined;
  if (current === undefined) {
    return diagnostic(
      'dag-design.selection-without-current',
      'Selected node ids require a current DAG.',
      ['selection', 'nodeIds'],
    );
  }
  const known = new Set(current.nodes.map(({ id }) => id));
  const unknown = selection.nodeIds.filter((id) => !known.has(id)).sort();
  return unknown.length === 0
    ? undefined
    : diagnostic(
        'dag-design.selection-unknown-node',
        `Selected node ids are not present in the current DAG: ${unknown.join(', ')}.`,
        ['selection', 'nodeIds'],
      );
}

function designSystemPrompt(
  options: DesignDagRuntimeOptions,
  capabilities: readonly { readonly id: string; readonly description: string }[],
  agents: readonly ToolAgent[],
): string {
  return composeSystemPrompt(options.agent.systemPrompt, {
    ...(options.extraSystemPrompt === undefined
      ? {}
      : { extraSystemPrompt: options.extraSystemPrompt }),
    dynamicSections: [
      `## Non-Executing DAG Design Mode
This turn only designs, revises, checks, or explains a DAG. It never executes the graph.
Return "propose" with one complete DAGSpec and a concise natural-language summary, "no-change"
only when a current DAG exists and is already correct, or "answer" for explanations.
Preserve unchanged node ids, fields, ordering, edges, and artifacts. Selected node ids are only a
focus hint. Use only the authoritative catalog below. Never claim to invoke handlers, create runs,
reviews, checkpoints, or workspace files.

Selected node ids: ${JSON.stringify(options.selection?.nodeIds ?? [])}
Current DAG: ${options.current === undefined ? 'null' : JSON.stringify(options.current)}
Current diagnostics: ${JSON.stringify(options.current === undefined ? [] : inspectDag(options.current))}

Capabilities:
${capabilities.map(({ id, description }) => `- ${id}: ${description}`).join('\n')}

Agents:
${agents.map(({ id, name, description }) => `- ${id}: ${name}${description ? ` — ${description}` : ''}`).join('\n')}`,
    ],
  });
}

type DagDesignEventInput = DagDesignEvent extends infer TEvent
  ? TEvent extends DagDesignEvent
    ? Omit<TEvent, 'sequence' | 'timestamp'>
    : never
  : never;

function designEventEmitter(
  listener: ((event: DagDesignEvent) => void | Promise<void>) | undefined,
): (event: DagDesignEventInput) => Promise<void> {
  let sequence = 0;
  return async (event) => {
    const normalized = dagDesignEventSchema.parse({
      ...event,
      sequence: ++sequence,
      timestamp: nowTimestamp(),
    });
    await listener?.(normalized);
  };
}

function diagnostic(
  code: string,
  message: string,
  path: readonly (string | number)[] = [],
  nodeId?: string,
): DagDiagnostic {
  return {
    severity: 'error',
    code,
    message,
    path,
    ...(nodeId === undefined ? {} : { nodeId }),
  };
}

function stripJsonFence(content: string): string {
  return content
    .trim()
    .replace(/^```(?:json)?\s*/iu, '')
    .replace(/\s*```$/u, '');
}
