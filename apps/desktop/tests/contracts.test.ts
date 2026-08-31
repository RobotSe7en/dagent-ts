import { describe, expect, it } from 'vitest';

import { desktopRequestSchema } from '../src/shared/contracts.js';

describe('desktop IPC contract', () => {
  it('accepts only a fixed ToolAgent run request and rejects injected targets', () => {
    const request = {
      action: 'run:start',
      conversationId: 'conversation_1',
      prompt: 'Inspect the project',
      capabilityIds: [],
      skillIds: [],
      agentIds: [],
      attachmentGrantIds: [],
      reviewLevel: 'risky',
    };
    expect(desktopRequestSchema.parse(request)).toEqual(request);
    expect(
      desktopRequestSchema.safeParse({
        ...request,
        target: { kind: 'dag-agent', id: 'Injected' },
      }).success,
    ).toBe(false);
  });

  it('does not expose DAG design, saved DAG, apply, or rollback actions', () => {
    for (const action of ['dag:design', 'saved-dag:create', 'changes:apply', 'changes:rollback']) {
      expect(desktopRequestSchema.safeParse({ action }).success).toBe(false);
    }
  });
});
