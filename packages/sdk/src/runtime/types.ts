import type {
  ContextPolicy,
  ContextUsage,
  ConversationState,
  PendingReview,
  ResultStoragePolicy,
  RunId,
} from '../contracts/index.js';
import type { CapabilityCatalog } from '../capabilities/catalog.js';
import type { ChatProvider } from '../providers/provider.js';
import type { ExecutionBudget } from './execution-budget.js';
import type { RunEventEmitter } from './events.js';

export type RuntimeExecutionContext = {
  readonly runId: RunId;
  readonly provider: ChatProvider;
  readonly catalog: CapabilityCatalog;
  readonly budget: ExecutionBudget;
  readonly events: RunEventEmitter;
  readonly workspacePath: string;
  readonly signal: AbortSignal;
  readonly contextPolicy: ContextPolicy;
  readonly resultStoragePolicy: ResultStoragePolicy;
  readonly contextWindowTokens: number;
  readonly outputReserveTokens: number;
};

export type AgentLoopResult =
  | {
      readonly status: 'completed';
      readonly conversation: ConversationState;
      readonly contextUsage: readonly ContextUsage[];
      readonly output: string;
    }
  | {
      readonly status: 'awaiting-review';
      readonly conversation: ConversationState;
      readonly contextUsage: readonly ContextUsage[];
      readonly review: PendingReview;
    };
