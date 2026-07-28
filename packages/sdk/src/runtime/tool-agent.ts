import type {
  ChatMessage,
  ChatResponse,
  ContextSummary,
  ContextUsage,
  ConversationItem,
  ConversationState,
  JsonObject,
  RunId,
  ReviewDecision,
  ToolAgent,
  ToolResultMessage,
  ModelScope,
  Attachment,
} from '../contracts/index.js';
import {
  appendConversationItems,
  assistantMessageSchema,
  contextSummarySchema,
  conversationStateSchema,
  createReviewId,
  inlineContent,
  invocationIdSchema,
  jsonObjectSchema,
  pendingReviewSchema,
  toolResultMessageSchema,
  userMessageSchema,
} from '../contracts/index.js';
import type { CapabilityDefinition, CapabilityInvocation } from '../contracts/index.js';
import { DagentError, errorMessage, throwIfAborted } from '../errors.js';
import type { ProviderTool } from '../providers/provider.js';
import { ContextAssembler } from './context-assembler.js';
import { normalizeCapabilityResult } from './result-storage.js';
import { withRetry } from './retry.js';
import type { AgentLoopResult, RuntimeExecutionContext } from './types.js';

export type ToolAgentInput = {
  readonly prompt?: string;
  readonly promptKind?: 'user-turn' | 'internal-continuation';
  readonly promptScope?: ModelScope;
  readonly conversation?: ConversationState;
  readonly attachments?: readonly Attachment[];
};

export type ResumeCapability = {
  readonly invocation: CapabilityInvocation;
  readonly decision: ReviewDecision;
};

export class ToolAgentRuntime {
  public async run(
    agent: ToolAgent,
    input: ToolAgentInput,
    context: RuntimeExecutionContext,
    resume?: ResumeCapability,
  ): Promise<AgentLoopResult> {
    const initialConversation = conversationStateSchema.parse(
      input.conversation ?? { schemaVersion: 3 },
    );
    let thread = conversationStateSchema.parse(initialConversation);
    if (input.prompt !== undefined) {
      const userTurn = input.promptKind !== 'internal-continuation';
      const prompt = userMessageSchema.parse({
        type: 'user',
        runId: context.runId,
        content: input.prompt,
        attachments: input.attachments ?? [],
        scope: input.promptScope ?? (userTurn ? 'conversation' : 'validator'),
        visibility: userTurn ? 'user' : 'internal',
      });
      thread = appendConversationItems(thread, prompt);
    }
    const contextUsages: ContextUsage[] = [];
    const assembler = new ContextAssembler({
      contextWindowTokens: context.contextWindowTokens,
      outputReserveTokens: context.outputReserveTokens,
    });
    const capabilityIds = [
      ...agent.scope.capabilities,
      ...(agent.scope.skills.length === 0 ? [] : ['skill.list', 'skill.view']),
    ];
    const definitions = context.catalog.definitions(capabilityIds);
    const providerTools = definitions.map(toProviderTool);

    if (resume !== undefined) {
      const reviewed = await this.#resumeCapability(resume, context, agent.scope.skills);
      thread = appendConversationItems(thread, reviewed);
    }

    for (let step = 0; step < agent.maxSteps; step += 1) {
      throwIfAborted(context.signal);
      let compactionStarted = false;
      const prepared = await assembler.prepare({
        systemMessage: { role: 'system', content: agent.systemPrompt },
        conversation: thread,
        tools: providerTools,
        policy: agent.context,
        compact: async (previous, items, maxTokens) => {
          compactionStarted = true;
          await context.events.emit({
            type: 'context-compaction-started',
            scope: 'conversation',
            itemCount: items.length,
          });
          const summary = await this.#compactHistory(previous, items, maxTokens, context);
          await context.events.emit({
            type: 'context-compaction-finished',
            scope: 'conversation',
            itemCount: items.length,
            method: 'model',
          });
          return summary;
        },
      });
      thread = prepared.conversation;
      contextUsages.push(prepared.usage);
      if (compactionStarted && prepared.usage.compactionMethod === 'deterministic-fallback') {
        await context.events.emit({
          type: 'context-compaction-finished',
          scope: 'conversation',
          itemCount: prepared.usage.compactedItems,
          method: 'deterministic-fallback',
        });
      }
      await context.events.emit({
        type: 'context-usage',
        scope: 'conversation',
        usage: prepared.usage,
      });

      context.budget.reserveModelCall(context.signal);
      const response = await this.#chat(prepared.messages, providerTools, context);
      const assistant = assistantMessageSchema.parse({
        type: 'assistant',
        runId: context.runId,
        content: response.content,
        reasoning: response.reasoningContent,
        refusal: response.refusal,
        ...(response.usage === undefined ? {} : { usage: response.usage }),
        toolCalls: response.toolCalls,
        scope: 'conversation',
        visibility: response.toolCalls.length === 0 ? 'user' : 'internal',
      });
      thread = appendConversationItems(thread, assistant);

      if (response.toolCalls.length === 0) {
        return {
          status: 'completed',
          conversation: thread,
          contextUsage: contextUsages,
          output: response.content,
        };
      }

      for (const call of response.toolCalls) {
        const binding = context.catalog.get(call.name);
        if (binding === undefined || !binding.definition.enabled) {
          const failed = invalidToolCallResult(
            call,
            context.runId,
            `Capability '${call.name}' is not available.`,
          );
          thread = appendConversationItems(thread, failed);
          continue;
        }
        let arguments_: JsonObject;
        try {
          arguments_ = jsonObjectSchema.parse(binding.input.parse(call.arguments));
        } catch (error) {
          const failed = invalidToolCallResult(
            call,
            context.runId,
            `Invalid arguments for '${call.name}': ${errorMessage(error)}`,
          );
          thread = appendConversationItems(thread, failed);
          continue;
        }
        const definition = binding.definition;
        const invocation: CapabilityInvocation = {
          id: invocationIdSchema.parse(call.id),
          capabilityId: definition.id,
          arguments: arguments_,
        };
        if (requiresReview(definition, agent.reviewLevel)) {
          const review = pendingReviewSchema.parse({
            id: createReviewId(),
            revision: thread.revision,
            kind: 'capability-review',
            summary: `Approve ${definition.id} (${definition.risk})`,
            invocation,
            createdAt: new Date().toISOString(),
          });
          await context.events.emit({ type: 'review-required', review });
          return {
            status: 'awaiting-review',
            conversation: thread,
            contextUsage: contextUsages,
            review,
          };
        }
        const result = await this.#invoke(invocation, context, agent.scope.skills);
        thread = appendConversationItems(thread, result);
      }
    }
    throw new DagentError(
      'BUDGET_EXCEEDED',
      `Tool agent '${agent.id}' exceeded maxSteps (${agent.maxSteps}).`,
    );
  }

  async #chat(
    messages: readonly ChatMessage[],
    tools: readonly ProviderTool[],
    context: RuntimeExecutionContext,
  ): Promise<ChatResponse> {
    let done: ChatResponse | undefined;
    for await (const event of context.provider.streamChat(
      { messages, tools },
      { signal: context.signal },
    )) {
      if (event.type === 'token') {
        await context.events.emit({
          type: 'token',
          channel: event.channel,
          content: event.content,
        });
      } else {
        done = event.response;
      }
    }
    if (done === undefined) {
      throw new DagentError('PROVIDER_FAILED', 'The provider stream ended without a response.');
    }
    return done;
  }

  async #invoke(
    invocation: CapabilityInvocation,
    context: RuntimeExecutionContext,
    skills?: readonly string[],
  ): Promise<ToolResultMessage> {
    context.budget.reserveCapabilityCall(context.signal);
    await context.events.emit({ type: 'capability-started', invocation });
    const { result } = await context.catalog.invoke(
      invocation.capabilityId,
      invocation.arguments,
      {
        runId: context.runId,
        workspacePath: context.workspacePath,
        signal: context.signal,
        metadata: skills === undefined ? {} : { skills: [...skills] },
      },
      invocation.id,
    );
    const normalized = await normalizeCapabilityResult(result, {
      workspacePath: context.workspacePath,
      policy: context.resultStoragePolicy,
    });
    await context.events.emit({ type: 'capability-completed', result: normalized.result });
    return toolResultMessageSchema.parse({
      type: 'tool-result',
      runId: context.runId,
      callId: invocation.id,
      name: invocation.capabilityId,
      capabilityId: invocation.capabilityId,
      status: normalized.result.status === 'completed' ? 'completed' : 'failed',
      content: normalized.content,
      value: normalized.result.output,
      ...(normalized.valueReference === undefined
        ? {}
        : { valueReference: normalized.valueReference }),
      artifacts: normalized.references,
      scope: 'conversation',
      visibility: 'internal',
    });
  }

  async #resumeCapability(
    resume: ResumeCapability,
    context: RuntimeExecutionContext,
    skills?: readonly string[],
  ): Promise<ToolResultMessage> {
    if (resume.decision.action === 'approve') {
      return this.#invoke(resume.invocation, context, skills);
    }
    return toolResultMessageSchema.parse({
      type: 'tool-result',
      runId: context.runId,
      callId: resume.invocation.id,
      name: resume.invocation.capabilityId,
      capabilityId: resume.invocation.capabilityId,
      status: 'denied',
      content: inlineContent(resume.decision.reason || 'The user denied this capability call.'),
      scope: 'conversation',
      visibility: 'internal',
    });
  }

  async #compactHistory(
    previous: ContextSummary | undefined,
    items: readonly ConversationItem[],
    maxTokens: number,
    context: RuntimeExecutionContext,
  ): Promise<ContextSummary> {
    const assembler = new ContextAssembler({
      contextWindowTokens: context.contextWindowTokens,
      outputReserveTokens: context.outputReserveTokens,
    });
    const [source, sourceTruncated] = assembler.truncateText(
      compactionSource(previous, items),
      Math.max(1, Math.floor((context.contextWindowTokens - context.outputReserveTokens) * 0.7)),
    );
    const systemMessage: ChatMessage = {
      role: 'system',
      content:
        'Summarize earlier conversation data for later continuation. Preserve user requirements, accepted plans, execution observations, unresolved failures, and constraints. Never include hidden reasoning. Return only the summary.',
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
      policy: context.contextPolicy,
    });
    context.budget.reserveModelCall(context.signal);
    const response = await withRetry(
      () => context.provider.chat({ messages: prepared.messages }, { signal: context.signal }),
      { signal: context.signal },
    );
    const rawContent = response.content.trim();
    if (rawContent.length === 0) throw new Error('Context compactor returned an empty summary.');
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
}

function toProviderTool(definition: CapabilityDefinition): ProviderTool {
  return {
    name: definition.id,
    description: definition.description,
    inputSchema: definition.inputSchema,
  };
}

function requiresReview(
  definition: CapabilityDefinition,
  level: ToolAgent['reviewLevel'],
): boolean {
  if (level === 'never') return false;
  if (level === 'always') return true;
  return definition.risk === 'high' || definition.risk === 'critical';
}

function invalidToolCallResult(
  call: { readonly id: string; readonly name: string },
  runId: RunId,
  message: string,
): ToolResultMessage {
  return toolResultMessageSchema.parse({
    type: 'tool-result',
    runId,
    callId: call.id,
    name: call.name,
    status: 'failed',
    content: inlineContent(message),
    scope: 'conversation',
    visibility: 'internal',
  });
}

function compactionSource(
  previous: ContextSummary | undefined,
  items: readonly ConversationItem[],
): string {
  const sections: string[] = [];
  if (previous !== undefined) sections.push(`Previous summary:\n${previous.content}`);
  for (const item of items) {
    if (item.type === 'user') sections.push(`User:\n${item.content}`);
    if (item.type === 'assistant') sections.push(`Assistant (${item.scope}):\n${item.content}`);
    if (item.type === 'tool-result') {
      sections.push(`Tool ${item.capabilityId ?? item.name} (${item.status})`);
    }
  }
  return sections.join('\n\n');
}
