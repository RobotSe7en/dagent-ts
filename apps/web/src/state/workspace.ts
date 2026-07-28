import type { RunEvent, RunId } from 'dagent-ai';
import { create } from 'zustand';

export type WorkspaceMode = 'chat' | 'dag' | 'workbench';

type WorkspaceState = {
  readonly projectId: string | undefined;
  readonly conversationId: string | undefined;
  readonly mode: WorkspaceMode;
  readonly activeRunId: RunId | undefined;
  readonly runEvents: readonly RunEvent[];
  readonly inspectorOpen: boolean;
  selectProject(projectId: string): void;
  selectConversation(conversationId: string): void;
  setMode(mode: WorkspaceMode): void;
  beginRun(runId: RunId): void;
  appendRunEvent(event: RunEvent): void;
  clearRun(): void;
  toggleInspector(): void;
};

export const useWorkspace = create<WorkspaceState>((set) => ({
  projectId: undefined,
  conversationId: undefined,
  mode: 'chat',
  activeRunId: undefined,
  runEvents: [],
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
    set({ activeRunId, runEvents: [] });
  },
  appendRunEvent: (event) => {
    set((state) => ({
      runEvents:
        state.runEvents.at(-1)?.sequence === event.sequence
          ? state.runEvents
          : [...state.runEvents, event],
    }));
  },
  clearRun: () => {
    set({ activeRunId: undefined });
  },
  toggleInspector: () => {
    set((state) => ({ inspectorOpen: !state.inspectorOpen }));
  },
}));
