import type { RunEvent, RunId } from 'dagent-ai';
import { create } from 'zustand';

export type WorkspaceMode = 'chat' | 'dag' | 'workbench';

type WorkspaceState = {
  readonly projectId: string | undefined;
  readonly conversationId: string | undefined;
  readonly mode: WorkspaceMode;
  readonly activeRunId: RunId | undefined;
  readonly runProjectId: string | undefined;
  readonly runConversationId: string | undefined;
  readonly runEvents: readonly RunEvent[];
  readonly runStreamError: string;
  readonly inspectorOpen: boolean;
  selectProject(projectId: string): void;
  selectConversation(conversationId: string): void;
  setMode(mode: WorkspaceMode): void;
  beginRun(runId: RunId): void;
  appendRunEvent(event: RunEvent): void;
  setRunStreamError(message: string): void;
  toggleInspector(): void;
};

export const useWorkspace = create<WorkspaceState>((set) => ({
  projectId: undefined,
  conversationId: undefined,
  mode: 'chat',
  activeRunId: undefined,
  runProjectId: undefined,
  runConversationId: undefined,
  runEvents: [],
  runStreamError: '',
  inspectorOpen: true,
  selectProject: (projectId) => {
    set({ projectId, conversationId: undefined, mode: 'chat' });
  },
  selectConversation: (conversationId) => {
    set({ conversationId, mode: 'chat' });
  },
  setMode: (mode) => {
    set({ mode });
  },
  beginRun: (activeRunId) => {
    set((state) => ({
      activeRunId,
      runProjectId: state.projectId,
      runConversationId: state.conversationId,
      runEvents: [],
      runStreamError: '',
    }));
  },
  appendRunEvent: (event) => {
    set((state) => {
      const trackedRunId = state.activeRunId ?? state.runEvents.at(-1)?.runId;
      const lastSequence = state.runEvents.at(-1)?.sequence ?? 0;
      if (trackedRunId !== event.runId || event.sequence <= lastSequence) return state;
      const terminal = event.type === 'run-completed' && event.outcome !== 'awaiting-review';
      return {
        runEvents: [...state.runEvents, event],
        ...(terminal ? { activeRunId: undefined } : {}),
      };
    });
  },
  setRunStreamError: (runStreamError) => {
    set({ runStreamError });
  },
  toggleInspector: () => {
    set((state) => ({ inspectorOpen: !state.inspectorOpen }));
  },
}));
