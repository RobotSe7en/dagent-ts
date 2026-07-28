import { beforeEach, describe, expect, it } from 'vitest';

import { useWorkspace } from './workspace.js';

beforeEach(() => {
  useWorkspace.setState({
    projectId: undefined,
    conversationId: undefined,
    mode: 'chat',
    activeRunId: undefined,
    runEvents: [],
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
      type: 'run-started',
      runId: 'new-run' as never,
      sequence: 1,
      timestamp: new Date().toISOString(),
    });
    useWorkspace.getState().clearRun();

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

    useWorkspace.getState().appendRunEvent(first);
    useWorkspace.getState().appendRunEvent(first);
    useWorkspace.getState().appendRunEvent(second);

    expect(useWorkspace.getState().runEvents.map(({ sequence }) => sequence)).toEqual([1, 2]);
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
