import {
  Activity,
  GitBranch,
  MessageSquare,
  PanelRightOpen,
  Settings2,
  SquareTerminal,
} from 'lucide-react';
import { lazy, Suspense, useState } from 'react';

import { ChatWorkspace } from '../features/chat/ChatWorkspace.js';
import { RunInspector } from '../features/inspector/RunInspector.js';
import { ProjectSidebar } from '../features/projects/ProjectSidebar.js';
import { RunMonitor } from '../features/run/RunMonitor.js';
import { SettingsDrawer } from '../features/settings/SettingsDrawer.js';
import { type WorkspaceMode, useWorkspace } from '../state/workspace.js';

const DagWorkspace = lazy(async () => {
  const module = await import('../features/dag/DagWorkspace.js');
  return { default: module.DagWorkspace };
});
const Workbench = lazy(async () => {
  const module = await import('../features/workbench/Workbench.js');
  return { default: module.Workbench };
});

const modes: readonly {
  readonly id: WorkspaceMode;
  readonly label: string;
  readonly icon: typeof MessageSquare;
}[] = [
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'dag', label: 'DAG', icon: GitBranch },
  { id: 'workbench', label: 'Workbench', icon: SquareTerminal },
];

export function AppShell() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { mode, setMode, inspectorOpen, toggleInspector, activeRunId } = useWorkspace();
  return (
    <div className="app-shell">
      <RunMonitor />
      <ProjectSidebar />
      <div className="app-main">
        <nav className="topbar">
          <div className="mode-tabs">
            {modes.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                className={mode === id ? 'active' : ''}
                onClick={() => {
                  setMode(id);
                }}
              >
                <Icon size={15} />
                {label}
              </button>
            ))}
          </div>
          <div className="topbar-actions">
            {activeRunId !== undefined ? (
              <span className="running-pill">
                <Activity size={13} />
                live
              </span>
            ) : null}
            {!inspectorOpen ? (
              <button className="icon-button" onClick={toggleInspector}>
                <PanelRightOpen size={16} />
              </button>
            ) : null}
            <button
              className="icon-button"
              title="设置"
              onClick={() => {
                setSettingsOpen(true);
              }}
            >
              <Settings2 size={16} />
            </button>
          </div>
        </nav>
        <div className={`content-grid ${inspectorOpen ? '' : 'wide'}`}>
          <main className="workspace-surface">
            {mode === 'chat' ? <ChatWorkspace /> : null}
            <Suspense fallback={<div className="workspace-loading">Loading…</div>}>
              {mode === 'dag' ? <DagWorkspace /> : null}
              {mode === 'workbench' ? <Workbench /> : null}
            </Suspense>
          </main>
          <RunInspector />
        </div>
      </div>
      {settingsOpen ? (
        <SettingsDrawer
          onClose={() => {
            setSettingsOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}
