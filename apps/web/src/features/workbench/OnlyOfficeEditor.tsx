import { useQuery } from '@tanstack/react-query';
import { FileWarning, LoaderCircle } from 'lucide-react';
import { useEffect, useId, useState } from 'react';

import { api } from '../../api/client.js';

type DocumentEditor = {
  destroyEditor?(): void;
};

type DocsApi = {
  new (elementId: string, config: Readonly<Record<string, unknown>>): DocumentEditor;
};

export function OnlyOfficeEditor(props: { readonly projectId: string; readonly path: string }) {
  const id = `onlyoffice-${useId().replaceAll(':', '')}`;
  const [scriptError, setScriptError] = useState('');
  const editor = useQuery({
    queryKey: ['onlyoffice-editor', props.projectId, props.path],
    queryFn: () => api.projectOnlyOffice(props.projectId, props.path),
  });

  useEffect(() => {
    if (editor.data === undefined) return;
    let instance: DocumentEditor | undefined;
    let disposed = false;
    void loadScript(editor.data.scriptUrl).then(
      () => {
        if (disposed) return;
        const constructor = docsApi();
        if (constructor === undefined) {
          setScriptError('OnlyOffice API did not expose DocsAPI.DocEditor.');
          return;
        }
        instance = new constructor(id, editor.data.config);
      },
      (error: unknown) => {
        if (!disposed) {
          setScriptError(error instanceof Error ? error.message : String(error));
        }
      },
    );
    return () => {
      disposed = true;
      instance?.destroyEditor?.();
    };
  }, [editor.data, id]);

  if (editor.isPending) {
    return (
      <div className="document-preview-state">
        <LoaderCircle className="spin" size={22} />
        正在加载文档编辑器…
      </div>
    );
  }
  if (editor.error !== null || scriptError !== '') {
    return (
      <div className="document-preview-state">
        <FileWarning size={22} />
        <strong>无法预览文档</strong>
        <span>{scriptError || editor.error?.message}</span>
      </div>
    );
  }
  return <div id={id} className="onlyoffice-editor" />;
}

const scriptLoads = new Map<string, Promise<void>>();

function loadScript(url: string): Promise<void> {
  const existing = scriptLoads.get(url);
  if (existing !== undefined) return existing;
  const loading = new Promise<void>((resolvePromise, reject) => {
    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.onload = () => resolvePromise();
    script.onerror = () => reject(new Error('OnlyOffice API script could not be loaded.'));
    document.head.append(script);
  });
  scriptLoads.set(url, loading);
  return loading;
}

function docsApi(): DocsApi | undefined {
  const value = (window as unknown as { readonly DocsAPI?: { readonly DocEditor?: DocsApi } })
    .DocsAPI?.DocEditor;
  return value;
}
