import type { ExecutionLimits, ExecutionUsage } from '../contracts/index.js';
import { executionLimitsSchema, executionUsageSchema, nowTimestamp } from '../contracts/index.js';
import { DagentError, throwIfAborted } from '../errors.js';

export class ExecutionBudget {
  public readonly limits: ExecutionLimits;
  readonly #startedAtMs: number;
  #modelCalls: number;
  #capabilityCalls: number;
  #nodeExecutions: number;
  readonly #startedAt: string;

  public constructor(limits: Partial<ExecutionLimits> = {}, usage?: ExecutionUsage) {
    this.limits = executionLimitsSchema.parse(limits);
    this.#startedAt = usage?.startedAt ?? nowTimestamp();
    this.#startedAtMs = Date.parse(this.#startedAt);
    this.#modelCalls = usage?.modelCalls ?? 0;
    this.#capabilityCalls = usage?.capabilityCalls ?? 0;
    this.#nodeExecutions = usage?.nodeExecutions ?? 0;
  }

  public reserveModelCall(signal?: AbortSignal): void {
    this.#assertActive(signal);
    if (this.#modelCalls >= this.limits.maxModelCalls) {
      this.#exceeded('model calls', this.limits.maxModelCalls);
    }
    this.#modelCalls += 1;
  }

  public reserveCapabilityCall(signal?: AbortSignal): void {
    this.#assertActive(signal);
    if (this.#capabilityCalls >= this.limits.maxCapabilityCalls) {
      this.#exceeded('capability calls', this.limits.maxCapabilityCalls);
    }
    this.#capabilityCalls += 1;
  }

  public reserveNodeExecution(signal?: AbortSignal): void {
    this.#assertActive(signal);
    if (this.#nodeExecutions >= this.limits.maxNodeExecutions) {
      this.#exceeded('node executions', this.limits.maxNodeExecutions);
    }
    this.#nodeExecutions += 1;
  }

  public snapshot(): ExecutionUsage {
    return executionUsageSchema.parse({
      modelCalls: this.#modelCalls,
      capabilityCalls: this.#capabilityCalls,
      nodeExecutions: this.#nodeExecutions,
      startedAt: this.#startedAt,
    });
  }

  #assertActive(signal?: AbortSignal): void {
    throwIfAborted(signal);
    if (Date.now() - this.#startedAtMs > this.limits.maxDurationMs) {
      this.#exceeded('run duration in milliseconds', this.limits.maxDurationMs);
    }
  }

  #exceeded(resource: string, limit: number): never {
    throw new DagentError(
      'BUDGET_EXCEEDED',
      `Execution limit exceeded for ${resource} (${limit}).`,
      { details: { resource, limit, usage: this.snapshot() } },
    );
  }
}
