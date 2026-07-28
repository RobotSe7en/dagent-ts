import { useQuery } from '@tanstack/react-query';
import { ChevronRight, FileCode2, Folder, FolderOpen, HardDrive } from 'lucide-react';
import { useState } from 'react';

import { api } from '../../api/client.js';
import { EmptyState } from '../../components/EmptyState.js';
import { useWorkspace } from '../../state/workspace.js';
import { OnlyOfficeEditor } from './OnlyOfficeEditor.js';

export function Workbench() {
  const projectId = useWorkspace((state) => state.projectId);
  const [path, setPath] = useState('');
  const [selectedFile, setSelectedFile] = useState<string>();
  const directory = useQuery({
    queryKey: ['files', projectId, path],
    queryFn: () => {
      if (projectId === undefined) throw new Error('Missing project.');
      return api.file(projectId, path);
    },
    enabled: projectId !== undefined,
  });
  const file = useQuery({
    queryKey: ['file', projectId, selectedFile],
    queryFn: () => {
      if (projectId === undefined || selectedFile === undefined) {
        throw new Error('Missing file selection.');
      }
      return api.file(projectId, selectedFile);
    },
    enabled: projectId !== undefined && selectedFile !== undefined,
  });

  if (projectId === undefined) {
    return (
      <EmptyState
        icon={<HardDrive size={28} />}
        title="选择项目"
        description="工作区浏览器只显示项目根目录内的文件。"
      />
    );
  }
  const entries = directory.data?.type === 'directory' ? directory.data.entries : [];
  return (
    <section className="workbench">
      <header className="workspace-header">
        <div>
          <span className="eyebrow">Workspace boundary</span>
          <h1>Workbench</h1>
        </div>
      </header>
      <div className="workbench-layout">
        <aside className="file-browser">
          <button
            className="file-root"
            onClick={() => {
              setPath('');
              setSelectedFile(undefined);
            }}
          >
            <FolderOpen size={16} />
            workspace
          </button>
          <div className="breadcrumb">{path === '' ? '/' : `/${path}`}</div>
          {path !== '' ? (
            <button
              className="file-row"
              onClick={() => {
                setPath(path.split('/').slice(0, -1).join('/'));
              }}
            >
              <ChevronRight size={13} className="back" />
              ..
            </button>
          ) : null}
          {entries.map((entry) => {
            const entryPath = path === '' ? entry.name : `${path}/${entry.name}`;
            return (
              <button
                key={entry.name}
                className={`file-row ${selectedFile === entryPath ? 'selected' : ''}`}
                onClick={() => {
                  if (entry.type === 'directory') {
                    setPath(entryPath);
                    setSelectedFile(undefined);
                  } else {
                    setSelectedFile(entryPath);
                  }
                }}
              >
                {entry.type === 'directory' ? <Folder size={15} /> : <FileCode2 size={15} />}
                <span>{entry.name}</span>
              </button>
            );
          })}
        </aside>
        <main className="file-preview">
          {file.data?.type === 'file' ? (
            <>
              <div className="panel-title">{file.data.path}</div>
              {isOnlyOfficeDocument(file.data.path) ? (
                <OnlyOfficeEditor projectId={projectId} path={file.data.path} />
              ) : (
                <pre>{file.data.content}</pre>
              )}
            </>
          ) : (
            <EmptyState
              icon={<FileCode2 size={26} />}
              title="选择文件"
              description="文本文件会在这里以只读方式预览。"
            />
          )}
        </main>
      </div>
    </section>
  );
}

function isOnlyOfficeDocument(path: string): boolean {
  return /\.(?:docx|pptx|xlsx)$/iu.test(path);
}
