import { z } from 'zod';

import { sha256 } from '../internal/stable-json.js';
import {
  checkpointSchemaVersionSchema,
  extraSystemPromptSchema,
  jsonObjectSchema,
  jsonValueSchema,
  reviewIdSchema,
  runIdSchema,
  runtimeDirectorySchema,
  runtimeSchemaVersionSchema,
  timestampSchema,
} from './common.js';
import { capabilityInvocationSchema, capabilityResultSchema } from './capability.js';
import { dagNodeResultSchema, dagSpecSchema } from './dag.js';
import { artifactFileManifestSchema, artifactStatesSchema } from './artifact.js';
import { contextPolicySchema, contextUsageSchema, resultStoragePolicySchema } from './context.js';
import { conversationStateSchema } from './conversation.js';
import {
  validationPolicySchema,
  validationRecordSchema,
  validationResultSchema,
} from './validation.js';

export const executionLimitsSchema = z
  .object({
    maxModelCalls: z.number().int().positive().default(50),
    maxCapabilityCalls: z.number().int().positive().default(100),
    maxNodeExecutions: z.number().int().positive().default(200),
    maxDurationMs: z
      .number()
      .int()
      .positive()
      .default(30 * 60 * 1000),
    maxConcurrency: z.number().int().positive().default(8),
  })
  .strict();
export type ExecutionLimits = z.infer<typeof executionLimitsSchema>;

export const executionUsageSchema = z
  .object({
    modelCalls: z.number().int().nonnegative().default(0),
    capabilityCalls: z.number().int().nonnegative().default(0),
    nodeExecutions: z.number().int().nonnegative().default(0),
    startedAt: timestampSchema,
  })
  .strict();
export type ExecutionUsage = z.infer<typeof executionUsageSchema>;

export const pendingReviewSchema = z
  .object({
    id: reviewIdSchema,
    revision: z.number().int().nonnegative(),
    kind: z.enum(['dag-review', 'capability-review']),
    summary: z.string(),
    proposedGraph: dagSpecSchema.optional(),
    rerunNodeIds: z.array(z.string()).readonly().default([]),
    invocation: capabilityInvocationSchema.optional(),
    metadata: jsonObjectSchema.default({}),
    createdAt: timestampSchema,
  })
  .strict();
export type PendingReview = z.infer<typeof pendingReviewSchema>;

export const staticAgentContinuationSchema = z
  .object({
    nodeId: z.string().min(1),
    agentId: z.string().min(1),
    invocation: capabilityInvocationSchema,
    conversation: conversationStateSchema,
    graphInput: jsonValueSchema,
  })
  .strict();
export type StaticAgentContinuation = z.infer<typeof staticAgentContinuationSchema>;

export const runStateSchema = z
  .object({
    schemaVersion: runtimeSchemaVersionSchema.default(4),
    runId: runIdSchema,
    status: z.enum([
      'pending',
      'planning',
      'awaiting-review',
      'running',
      'completed',
      'failed',
      'cancelled',
      'interrupted',
    ]),
    targetKind: z.enum(['tool-agent', 'dag-agent', 'auto-agent', 'static-dag']),
    conversation: conversationStateSchema.optional(),
    contextUsage: z.array(contextUsageSchema).readonly().default([]),
    validations: z.array(validationRecordSchema).readonly().default([]),
    graphInput: jsonValueSchema.default({}),
    graph: dagSpecSchema.optional(),
    nodeResults: z.record(z.string(), dagNodeResultSchema).default({}),
    artifactStates: artifactStatesSchema.default({}),
    inputArtifactFiles: z.array(artifactFileManifestSchema).readonly().default([]),
    pendingReview: pendingReviewSchema.optional(),
    staticAgentContinuation: staticAgentContinuationSchema.optional(),
    output: jsonValueSchema.optional(),
    error: z.string().optional(),
    workspacePath: z.string(),
    revision: z.number().int().nonnegative(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .superRefine((state, context) => {
    if (state.schemaVersion === 3 && state.inputArtifactFiles.length > 0) {
      context.addIssue({
        code: 'custom',
        message: 'RunState V3 cannot contain input artifact file manifests.',
        path: ['inputArtifactFiles'],
      });
      return;
    }
    const ids = state.inputArtifactFiles.map(({ artifactId }) => artifactId);
    const sortedIds = [...new Set(ids)].sort();
    if (ids.length !== sortedIds.length || ids.some((id, index) => id !== sortedIds[index])) {
      context.addIssue({
        code: 'custom',
        message: 'Input artifact manifests must have unique, sorted artifact ids.',
        path: ['inputArtifactFiles'],
      });
    }
    if (state.inputArtifactFiles.length === 0) return;
    if (state.targetKind !== 'static-dag' || state.graph === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Input artifact manifests require a static DAG state.',
        path: ['inputArtifactFiles'],
      });
      return;
    }
    for (const [manifestIndex, manifest] of state.inputArtifactFiles.entries()) {
      const artifact = state.graph.artifacts[manifest.artifactId];
      if (artifact === undefined) {
        context.addIssue({
          code: 'custom',
          message: `Input artifact manifest references unknown artifact '${manifest.artifactId}'.`,
          path: ['inputArtifactFiles', manifestIndex, 'artifactId'],
        });
        continue;
      }
      for (const [fileIndex, file] of manifest.files.entries()) {
        if (!artifact.paths.some((path) => artifactDeclaresFile(path, file.path))) {
          context.addIssue({
            code: 'custom',
            message: `Artifact file '${file.path}' is outside declared artifact '${manifest.artifactId}'.`,
            path: ['inputArtifactFiles', manifestIndex, 'files', fileIndex, 'path'],
          });
        }
      }
    }
  });
export type RunState = z.infer<typeof runStateSchema>;

const resolvedRunPlanPayloadShape = {
  schemaVersion: checkpointSchemaVersionSchema.default(5),
  target: z.record(z.string(), z.unknown()),
  capabilityIds: z.array(z.string()),
  capabilityFingerprints: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
  skillIds: z.array(z.string()),
  agentIds: z.array(z.string()),
  agentFingerprints: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
  limits: executionLimitsSchema,
  contextPolicy: contextPolicySchema.prefault({}),
  resultStoragePolicy: resultStoragePolicySchema.prefault({}),
  runtimeDirectory: runtimeDirectorySchema,
  contextWindowTokens: z.number().int().min(1024).default(32_768),
  outputReserveTokens: z.number().int().nonnegative().default(4096),
  extraSystemPrompt: extraSystemPromptSchema.optional(),
  validation: validationPolicySchema.prefault({}),
} as const;

export const resolvedRunPlanPayloadSchema = z.object(resolvedRunPlanPayloadShape).strict();

export const resolvedRunPlanSchema = z
  .object({
    ...resolvedRunPlanPayloadShape,
    fingerprint: z.string().min(1),
  })
  .strict()
  .superRefine((plan, context) => {
    const {
      capabilityIds,
      capabilityFingerprints,
      skillIds,
      agentIds,
      agentFingerprints,
      contextWindowTokens,
      outputReserveTokens,
      fingerprint,
    } = plan;
    const payload: Record<string, unknown> = { ...plan };
    delete payload['fingerprint'];
    if (outputReserveTokens >= contextWindowTokens) {
      context.addIssue({
        code: 'custom',
        message: 'outputReserveTokens must be smaller than contextWindowTokens.',
        path: ['outputReserveTokens'],
      });
    }
    const ids = [...new Set(capabilityIds)].sort();
    const fingerprintIds = Object.keys(capabilityFingerprints).sort();
    if (
      ids.length !== capabilityIds.length ||
      ids.length !== fingerprintIds.length ||
      ids.some((id, index) => id !== fingerprintIds[index])
    ) {
      context.addIssue({
        code: 'custom',
        message: 'capabilityFingerprints must exactly match unique capabilityIds.',
        path: ['capabilityFingerprints'],
      });
    }
    const canonicalSkillIds = [...new Set(skillIds)].sort();
    if (
      canonicalSkillIds.length !== skillIds.length ||
      canonicalSkillIds.some((id, index) => id !== skillIds[index])
    ) {
      context.addIssue({
        code: 'custom',
        message: 'skillIds must be unique and sorted.',
        path: ['skillIds'],
      });
    }
    const canonicalAgentIds = [...new Set(agentIds)].sort();
    const agentFingerprintIds = Object.keys(agentFingerprints).sort();
    if (
      canonicalAgentIds.length !== agentIds.length ||
      canonicalAgentIds.some((id, index) => id !== agentIds[index]) ||
      canonicalAgentIds.length !== agentFingerprintIds.length ||
      canonicalAgentIds.some((id, index) => id !== agentFingerprintIds[index])
    ) {
      context.addIssue({
        code: 'custom',
        message: 'agentFingerprints must exactly match unique sorted agentIds.',
        path: ['agentFingerprints'],
      });
    }
    const expectedFingerprint = sha256(
      JSON.parse(JSON.stringify(payload)) as z.infer<typeof jsonValueSchema>,
    );
    if (fingerprint !== expectedFingerprint) {
      context.addIssue({
        code: 'custom',
        message: 'Resolved run plan fingerprint does not match its payload.',
        path: ['fingerprint'],
      });
    }
  });
export type ResolvedRunPlan = z.infer<typeof resolvedRunPlanSchema>;

export const runCheckpointSchema = z
  .object({
    schemaVersion: checkpointSchemaVersionSchema.default(5),
    state: runStateSchema,
    plan: resolvedRunPlanSchema,
    usage: executionUsageSchema,
    createdAt: timestampSchema,
  })
  .strict()
  .superRefine(({ schemaVersion, state, plan, usage }, context) => {
    if (schemaVersion !== plan.schemaVersion) {
      context.addIssue({
        code: 'custom',
        message: 'Checkpoint schema version does not match its resolved plan.',
        path: ['plan', 'schemaVersion'],
      });
    }
    if (plan.schemaVersion !== (state.schemaVersion === 4 ? 5 : 4)) {
      context.addIssue({
        code: 'custom',
        message: 'Resolved plan and run state schema versions are incompatible.',
        path: ['state', 'schemaVersion'],
      });
    }
    if (plan.target['kind'] !== state.targetKind) {
      context.addIssue({
        code: 'custom',
        message: 'Checkpoint target kind does not match its run state.',
        path: ['state', 'targetKind'],
      });
    }
    const awaitingReview = state.status === 'awaiting-review';
    if (awaitingReview !== (state.pendingReview !== undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'pendingReview must exist if and only if the run is awaiting review.',
        path: ['state', 'pendingReview'],
      });
    }
    const review = state.pendingReview;
    if (review?.kind === 'capability-review') {
      if (review.invocation === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'A capability review requires an invocation.',
          path: ['state', 'pendingReview', 'invocation'],
        });
      } else if (!plan.capabilityIds.includes(review.invocation.capabilityId)) {
        context.addIssue({
          code: 'custom',
          message: 'The reviewed capability is not part of the resolved plan.',
          path: ['state', 'pendingReview', 'invocation', 'capabilityId'],
        });
      }
    }
    if (review?.kind === 'dag-review' && review.proposedGraph === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'A DAG review requires a proposed graph.',
        path: ['state', 'pendingReview', 'proposedGraph'],
      });
    }
    const continuation = state.staticAgentContinuation;
    if (continuation !== undefined) {
      if (
        state.targetKind !== 'static-dag' ||
        state.status !== 'awaiting-review' ||
        review?.kind !== 'capability-review' ||
        review.invocation === undefined ||
        JSON.stringify(review.invocation) !== JSON.stringify(continuation.invocation) ||
        !plan.agentIds.includes(continuation.agentId)
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Static agent continuation does not match the pending capability review.',
          path: ['state', 'staticAgentContinuation'],
        });
      }
    } else if (state.targetKind === 'static-dag' && review?.kind === 'capability-review') {
      context.addIssue({
        code: 'custom',
        message: 'Static DAG capability reviews require an agent continuation.',
        path: ['state', 'staticAgentContinuation'],
      });
    }
    const limits = [
      ['modelCalls', usage.modelCalls, plan.limits.maxModelCalls],
      ['capabilityCalls', usage.capabilityCalls, plan.limits.maxCapabilityCalls],
      ['nodeExecutions', usage.nodeExecutions, plan.limits.maxNodeExecutions],
    ] as const;
    for (const [field, consumed, limit] of limits) {
      if (consumed > limit) {
        context.addIssue({
          code: 'custom',
          message: `${field} exceeds its resolved execution limit.`,
          path: ['usage', field],
        });
      }
    }
  });
export type RunCheckpoint = z.infer<typeof runCheckpointSchema>;

function artifactDeclaresFile(declaredPath: string, filePath: string): boolean {
  const normalized = declaredPath.replaceAll('\\', '/').replace(/\/+$/u, '');
  const normalizedFile = filePath.replaceAll('\\', '/');
  return normalizedFile === normalized || normalizedFile.startsWith(`${normalized}/`);
}

const eventBaseShape = {
  runId: runIdSchema,
  sequence: z.number().int().positive(),
  timestamp: timestampSchema,
} as const;

export const runEventSchema = z.discriminatedUnion('type', [
  z.object({ ...eventBaseShape, type: z.literal('run-started') }),
  z.object({
    ...eventBaseShape,
    type: z.literal('token'),
    channel: z.enum(['reasoning', 'content']),
    content: z.string(),
  }),
  z.object({
    ...eventBaseShape,
    type: z.literal('plan-proposed'),
    graph: dagSpecSchema,
  }),
  z.object({
    ...eventBaseShape,
    type: z.literal('review-required'),
    review: pendingReviewSchema,
  }),
  z.object({
    ...eventBaseShape,
    type: z.literal('node-started'),
    nodeId: z.string(),
  }),
  z.object({
    ...eventBaseShape,
    type: z.literal('node-completed'),
    result: dagNodeResultSchema,
  }),
  z.object({
    ...eventBaseShape,
    type: z.literal('capability-started'),
    invocation: capabilityInvocationSchema,
  }),
  z.object({
    ...eventBaseShape,
    type: z.literal('capability-completed'),
    result: capabilityResultSchema,
  }),
  z.object({
    ...eventBaseShape,
    type: z.literal('checkpoint'),
    checkpoint: runCheckpointSchema,
  }),
  z.object({
    ...eventBaseShape,
    type: z.literal('context-compaction-started'),
    scope: z.enum(['conversation', 'router', 'planner', 'validator', 'subagent', 'compactor']),
    itemCount: z.number().int().nonnegative(),
  }),
  z.object({
    ...eventBaseShape,
    type: z.literal('context-compaction-finished'),
    scope: z.enum(['conversation', 'router', 'planner', 'validator', 'subagent', 'compactor']),
    itemCount: z.number().int().nonnegative(),
    method: z.enum(['model', 'deterministic-fallback']),
  }),
  z.object({
    ...eventBaseShape,
    type: z.literal('context-usage'),
    scope: z.enum(['conversation', 'router', 'planner', 'validator', 'subagent', 'compactor']),
    usage: contextUsageSchema,
  }),
  z.object({
    ...eventBaseShape,
    type: z.literal('validation-started'),
    attempt: z.number().int().nonnegative(),
  }),
  z.object({
    ...eventBaseShape,
    type: z.literal('validation-finished'),
    attempt: z.number().int().nonnegative(),
    result: validationResultSchema,
    willRetry: z.boolean(),
  }),
  z.object({
    ...eventBaseShape,
    type: z.literal('run-completed'),
    outcome: z.enum(['completed', 'awaiting-review', 'failed', 'cancelled', 'interrupted']),
  }),
]);
export type RunEvent = z.infer<typeof runEventSchema>;

export const reviewDecisionSchema = z
  .object({
    reviewId: reviewIdSchema,
    revision: z.number().int().nonnegative(),
    action: z.enum(['approve', 'reject']),
    reason: z.string().default(''),
    replacementGraph: dagSpecSchema.optional(),
  })
  .strict();
export type ReviewDecision = z.infer<typeof reviewDecisionSchema>;

export type RunOutcome =
  | {
      readonly status: 'completed';
      readonly state: RunState;
      readonly checkpoint: RunCheckpoint;
      readonly output?: z.infer<typeof jsonValueSchema>;
    }
  | {
      readonly status: 'awaiting-review';
      readonly state: RunState;
      readonly checkpoint: RunCheckpoint;
      readonly review: PendingReview;
    }
  | {
      readonly status: 'failed' | 'cancelled' | 'interrupted';
      readonly state: RunState;
      readonly checkpoint: RunCheckpoint;
      readonly error: string;
    };
