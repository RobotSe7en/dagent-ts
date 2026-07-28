import { afterEach, describe, expect, it, vi } from 'vitest';

import { ExecutionBudget } from './execution-budget.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('ExecutionBudget', () => {
  it('accounts for each independently bounded resource', () => {
    const budget = new ExecutionBudget({
      maxModelCalls: 2,
      maxCapabilityCalls: 2,
      maxNodeExecutions: 2,
    });

    budget.reserveModelCall();
    budget.reserveCapabilityCall();
    budget.reserveNodeExecution();

    expect(budget.snapshot()).toMatchObject({
      modelCalls: 1,
      capabilityCalls: 1,
      nodeExecutions: 1,
    });
  });

  it.each([
    ['model', (budget: ExecutionBudget) => budget.reserveModelCall()],
    ['capability', (budget: ExecutionBudget) => budget.reserveCapabilityCall()],
    ['node', (budget: ExecutionBudget) => budget.reserveNodeExecution()],
  ] as const)('enforces the %s call limit before incrementing usage', (_name, reserve) => {
    const budget = new ExecutionBudget({
      maxModelCalls: 1,
      maxCapabilityCalls: 1,
      maxNodeExecutions: 1,
    });
    reserve(budget);

    expect(() => reserve(budget)).toThrow(expect.objectContaining({ code: 'BUDGET_EXCEEDED' }));
  });

  it('continues accounting from a checkpoint usage snapshot', () => {
    const first = new ExecutionBudget({ maxModelCalls: 3 });
    first.reserveModelCall();
    const resumed = new ExecutionBudget({ maxModelCalls: 3 }, first.snapshot());
    resumed.reserveModelCall();

    expect(resumed.snapshot().modelCalls).toBe(2);
  });

  it('enforces wall-clock duration and cancellation', () => {
    vi.useFakeTimers();
    const budget = new ExecutionBudget({ maxDurationMs: 100 });
    vi.advanceTimersByTime(101);
    expect(() => budget.reserveModelCall()).toThrow(
      expect.objectContaining({ code: 'BUDGET_EXCEEDED' }),
    );

    const controller = new AbortController();
    controller.abort();
    expect(() => new ExecutionBudget().reserveModelCall(controller.signal)).toThrow(
      expect.objectContaining({ code: 'ABORTED' }),
    );
  });
});
