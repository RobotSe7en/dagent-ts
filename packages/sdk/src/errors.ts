export type DagentErrorCode =
  | 'ABORTED'
  | 'BUDGET_EXCEEDED'
  | 'CAPABILITY_FAILED'
  | 'CAPABILITY_NOT_FOUND'
  | 'CHECKPOINT_MISMATCH'
  | 'CONCURRENCY_CONFLICT'
  | 'DAG_EXECUTION_FAILED'
  | 'DAG_VALIDATION_FAILED'
  | 'INVALID_INPUT'
  | 'MCP_CONNECTION_FAILED'
  | 'PROVIDER_FAILED'
  | 'REVIEW_REQUIRED'
  | 'SANDBOX_UNAVAILABLE'
  | 'STALE_REVIEW'
  | 'WORKSPACE_VIOLATION';

export class DagentError extends Error {
  public readonly code: DagentErrorCode;
  public readonly details: Readonly<Record<string, unknown>>;
  public override readonly cause: unknown;

  public constructor(
    code: DagentErrorCode,
    message: string,
    options: {
      readonly cause?: unknown;
      readonly details?: Readonly<Record<string, unknown>>;
    } = {},
  ) {
    super(message);
    this.name = 'DagentError';
    this.code = code;
    this.cause = options.cause;
    this.details = Object.freeze({ ...options.details });
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DagentError('ABORTED', 'The run was cancelled.', {
      cause: signal.reason,
    });
  }
}
