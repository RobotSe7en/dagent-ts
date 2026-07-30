import { beforeEach, describe, expect, it } from 'vitest';

import { useWorkspace } from './workspace.js';

beforeEach(() => {
  useWorkspace.setState({
    projectId: undefined,
    conversationId: undefined,
    mode: 'chat',
    activeRunId: undefined,
    runProjectId: undefined,
    runConversationId: undefined,
    runEvents: [],
    runStreamError: '',
    inspectorOpen: true,
  });
});

describe('workspace state', () => {
  it('clears project-scoped conversation selection when switching projects', () => {
    useWorkspace.getState().selectProject('project-a');
    useWorkspace.getState().selectConversation('conversation-a');
    useWorkspace.getState().setMode('dag');

    useWorkspace.getState().selectProject('project-b');

    expect(useWorkspace.getState()).toMatchObject({
      projectId: 'project-b',
      conversationId: undefined,
      mode: 'chat',
    });
  });

  it('starts runs with a clean event stream and preserves completed events for inspection', () => {
    useWorkspace.setState({
      runEvents: [
        {
          type: 'run-started',
          runId: 'old-run' as never,
          sequence: 1,
          timestamp: new Date().toISOString(),
        },
      ],
    });

    useWorkspace.getState().beginRun('new-run' as never);
    expect(useWorkspace.getState().runEvents).toEqual([]);

    useWorkspace.getState().appendRunEvent({
      type: 'run-completed',
      runId: 'new-run' as never,
      sequence: 1,
      timestamp: new Date().toISOString(),
      outcome: 'completed',
    });

    expect(useWorkspace.getState().activeRunId).toBeUndefined();
    expect(useWorkspace.getState().runEvents).toHaveLength(1);
  });

  it('deduplicates a repeated SSE sequence without dropping later events', () => {
    const first = {
      type: 'run-started' as const,
      runId: 'run' as never,
      sequence: 1,
      timestamp: new Date().toISOString(),
    };
    const second = {
      type: 'run-completed' as const,
      runId: 'run' as never,
      sequence: 2,
      timestamp: new Date().toISOString(),
      outcome: 'completed' as const,
    };

    useWorkspace.getState().beginRun('run' as never);
    useWorkspace.getState().appendRunEvent(first);
    useWorkspace.getState().appendRunEvent(first);
    useWorkspace.getState().appendRunEvent(second);
    useWorkspace.getState().appendRunEvent(first);

    expect(useWorkspace.getState().runEvents.map(({ sequence }) => sequence)).toEqual([1, 2]);
  });

  it('keeps an awaiting-review run active until a terminal outcome arrives', () => {
    useWorkspace.getState().beginRun('review-run' as never);
    useWorkspace.getState().appendRunEvent({
      type: 'run-completed',
      runId: 'review-run' as never,
      sequence: 1,
      timestamp: new Date().toISOString(),
      outcome: 'awaiting-review',
    });

    expect(useWorkspace.getState().activeRunId).toBe('review-run');
  });

  it('keeps an active run associated with the conversation that started it', () => {
    useWorkspace.getState().selectProject('project-a');
    useWorkspace.getState().selectConversation('conversation-a');
    useWorkspace.getState().beginRun('run-a' as never);

    useWorkspace.getState().selectConversation('conversation-b');

    expect(useWorkspace.getState()).toMatchObject({
      activeRunId: 'run-a',
      runProjectId: 'project-a',
      runConversationId: 'conversation-a',
      conversationId: 'conversation-b',
    });
    useWorkspace.getState().appendRunEvent({
      type: 'run-completed',
      runId: 'different-run' as never,
      sequence: 1,
      timestamp: new Date().toISOString(),
      outcome: 'completed',
    });
    expect(useWorkspace.getState().activeRunId).toBe('run-a');
  });

  it('toggles the inspector independently from the active workspace mode', () => {
    useWorkspace.getState().setMode('workbench');
    useWorkspace.getState().toggleInspector();

    expect(useWorkspace.getState()).toMatchObject({
      mode: 'workbench',
      inspectorOpen: false,
    });
  });
});
