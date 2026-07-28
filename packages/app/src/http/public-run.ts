import type { RunEvent } from 'dagent-ai';

import type { StoredRun } from '../database/repositories.js';
import { publicConversationState } from './public-conversation.js';

export function publicRunSummary(run: StoredRun) {
  return {
    id: run.id,
    ...(run.conversationId === undefined ? {} : { conversationId: run.conversationId }),
    ...(run.savedDagId === undefined ? {} : { savedDagId: run.savedDagId }),
    ...(run.orchestrationSessionId === undefined
      ? {}
      : { orchestrationSessionId: run.orchestrationSessionId }),
    target: publicTarget(run.target),
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

export function publicRun(run: StoredRun) {
  return {
    ...publicRunSummary(run),
    input: run.input,
    ...(run.checkpoint === undefined ? {} : { checkpoint: publicCheckpoint(run.checkpoint) }),
  };
}

export function publicRunEvent(event: RunEvent): object | undefined {
  if (event.type === 'token' && event.channel === 'reasoning') return undefined;
  if (event.type !== 'checkpoint') return event;
  return { ...event, checkpoint: publicCheckpoint(event.checkpoint) };
}

export function publicRunTrace(run: StoredRun, events: readonly RunEvent[]) {
  const checkpoint = run.checkpoint;
  const visibleEvents = events
    .map(publicRunEvent)
    .filter((event): event is NonNullable<typeof event> => event !== undefined);
  return {
    runId: run.id,
    status: run.status,
    target: publicTarget(run.target),
    startedAt: run.createdAt,
    updatedAt: run.updatedAt,
    durationMs: Math.max(0, Date.parse(run.updatedAt) - Date.parse(run.createdAt)),
    summary: {
      modelCalls: checkpoint?.usage.modelCalls ?? 0,
      capabilityCalls: checkpoint?.usage.capabilityCalls ?? 0,
      nodeExecutions: checkpoint?.usage.nodeExecutions ?? 0,
      validationAttempts: checkpoint?.state.validations.length ?? 0,
      eventCount: visibleEvents.length,
    },
    ...(checkpoint === undefined
      ? {}
      : {
          state: publicState(checkpoint.state),
          plan: publicPlan(checkpoint.plan),
          usage: checkpoint.usage,
        }),
    events: visibleEvents,
  };
}

function publicCheckpoint(checkpoint: NonNullable<StoredRun['checkpoint']>) {
  return {
    schemaVersion: checkpoint.schemaVersion,
    state: publicState(checkpoint.state),
    plan: publicPlan(checkpoint.plan),
    usage: checkpoint.usage,
    createdAt: checkpoint.createdAt,
  };
}

function publicState(state: NonNullable<StoredRun['checkpoint']>['state']) {
  const { conversation } = state;
  const visible = { ...state };
  delete visible.modelThread;
  delete visible.conversation;
  return {
    ...visible,
    ...(conversation === undefined
      ? {}
      : {
          conversation: publicConversationState(conversation),
        }),
  };
}

function publicPlan(plan: NonNullable<StoredRun['checkpoint']>['plan']) {
  return {
    ...plan,
    target: publicTarget(plan.target),
    validation: {
      enabled: plan.validation.enabled,
      maxRetries: plan.validation.maxRetries,
      ...(plan.validation.profile === undefined ? {} : { profile: plan.validation.profile.name }),
    },
  };
}

function publicTarget(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const target = value as Record<string, unknown>;
  const visible = { ...target };
  delete visible['systemPrompt'];
  if (target['kind'] !== 'auto-agent') return visible;
  return {
    ...visible,
    toolAgent: publicTarget(target['toolAgent']),
    dagAgent: publicTarget(target['dagAgent']),
  };
}
