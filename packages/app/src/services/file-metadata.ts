import { basename, extname } from 'node:path';

export type FilePreviewKind = 'code' | 'document' | 'markdown' | 'pdf' | 'text';

export function mediaTypeForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.css':
      return 'text/css; charset=utf-8';
    case '.csv':
      return 'text/csv; charset=utf-8';
    case '.gif':
      return 'image/gif';
    case '.htm':
    case '.html':
      return 'text/html; charset=utf-8';
    case '.jpeg':
    case '.jpg':
      return 'image/jpeg';
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.md':
    case '.mdx':
      return 'text/markdown; charset=utf-8';
    case '.pdf':
      return 'application/pdf';
    case '.png':
      return 'image/png';
    case '.svg':
      return 'image/svg+xml';
    case '.ts':
    case '.tsx':
      return 'text/plain; charset=utf-8';
    case '.txt':
      return 'text/plain; charset=utf-8';
    case '.webp':
      return 'image/webp';
    case '.xml':
      return 'application/xml; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

export function previewKindForPath(path: string): FilePreviewKind | undefined {
  switch (extname(path).toLowerCase()) {
    case '.md':
    case '.mdx':
      return 'markdown';
    case '.c':
    case '.cpp':
    case '.css':
    case '.go':
    case '.h':
    case '.html':
    case '.java':
    case '.js':
    case '.json':
    case '.jsx':
    case '.mjs':
    case '.py':
    case '.rs':
    case '.sh':
    case '.sql':
    case '.ts':
    case '.tsx':
    case '.xml':
    case '.yaml':
    case '.yml':
      return 'code';
    case '.csv':
    case '.log':
    case '.txt':
      return 'text';
    case '.pdf':
      return 'pdf';
    case '.docx':
    case '.pptx':
    case '.xlsx':
      return 'document';
    default:
      return undefined;
  }
}

export function attachmentHeader(name: string): string {
  const safeName = basename(name).replaceAll(/["\\\r\n]/gu, '_');
  return `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`;
}
