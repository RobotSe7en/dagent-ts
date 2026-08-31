import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import type { ProjectFileDownload, ProjectFileView } from 'dagent-ai-app';

import { invoke } from './api.js';

export function FilePreview({
  projectId,
  file,
}: {
  readonly projectId: string;
  readonly file: Extract<ProjectFileView, { readonly type: 'file' }>;
}) {
  const [download, setDownload] = useState<ProjectFileDownload>();
  const needsBytes =
    file.content === undefined &&
    (file.mediaType.startsWith('image/') || file.mediaType === 'application/pdf');

  useEffect(() => {
    setDownload(undefined);
    if (!needsBytes) return;
    void invoke<ProjectFileDownload>({ action: 'file:read', projectId, path: file.path }).then(
      setDownload,
    );
  }, [file.path, needsBytes, projectId]);

  const objectUrl = useObjectUrl(download);
  if (file.mediaType === 'text/markdown' || /\.mdx?$/iu.test(file.path)) {
    return <ReactMarkdown remarkPlugins={[remarkGfm]}>{file.content ?? ''}</ReactMarkdown>;
  }
  if (/\.mmd$|\.mermaid$/iu.test(file.path) && file.content !== undefined) {
    return <MermaidPreview source={file.content} />;
  }
  if (file.mediaType === 'image/svg+xml' && file.content !== undefined) {
    return (
      <img
        className="visual-preview"
        alt={file.name}
        src={`data:image/svg+xml,${encodeURIComponent(file.content)}`}
      />
    );
  }
  if (file.mediaType === 'text/html' && file.content !== undefined) {
    return <iframe className="html-preview" sandbox="" title={file.name} srcDoc={file.content} />;
  }
  if (file.mediaType === 'application/pdf' && objectUrl !== undefined) {
    return <iframe className="pdf-preview" title={file.name} src={objectUrl} />;
  }
  if (file.mediaType.startsWith('image/') && objectUrl !== undefined) {
    return <img className="visual-preview" alt={file.name} src={objectUrl} />;
  }
  if (file.content !== undefined) return <pre className="code-preview">{file.content}</pre>;
  return (
    <div className="empty-preview">
      此文件无法在应用内预览（{file.previewOmitted ?? 'binary'}）。
    </div>
  );
}

function MermaidPreview({ source }: { readonly source: string }) {
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    void import('mermaid').then(async ({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' });
      try {
        const rendered = await mermaid.render(`diagram-${crypto.randomUUID()}`, source);
        if (!disposed) setSvg(rendered.svg);
      } catch (reason) {
        if (!disposed) setError(reason instanceof Error ? reason.message : '图表渲染失败。');
      }
    });
    return () => {
      disposed = true;
    };
  }, [source]);
  if (error.length > 0) return <div className="empty-preview">{error}</div>;
  return <div className="mermaid-preview" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function useObjectUrl(download: ProjectFileDownload | undefined): string | undefined {
  const bytes = download?.content;
  const mediaType = download?.mediaType;
  const url = useMemo(() => {
    if (bytes === undefined || mediaType === undefined) return undefined;
    return URL.createObjectURL(new Blob([Uint8Array.from(bytes).buffer], { type: mediaType }));
  }, [bytes, mediaType]);
  useEffect(
    () => () => {
      if (url !== undefined) URL.revokeObjectURL(url);
    },
    [url],
  );
  return url;
}
