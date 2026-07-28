import { isAbsolute, posix, win32 } from 'node:path';

import { DagentError } from '../errors.js';

export function validateArtifactPath(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  if (normalized.trim().length === 0) {
    throw new DagentError('WORKSPACE_VIOLATION', 'Artifact path cannot be empty.');
  }
  if (isAbsolute(path) || win32.isAbsolute(path) || win32.parse(path).root.length > 0) {
    throw new DagentError(
      'WORKSPACE_VIOLATION',
      `Artifact path '${path}' must be workspace-relative.`,
    );
  }
  if (normalized.split('/').includes('..')) {
    throw new DagentError(
      'WORKSPACE_VIOLATION',
      `Artifact path '${path}' cannot contain parent traversal.`,
    );
  }
  return posix.normalize(normalized);
}

export function validateUploadFilename(filename: string): string {
  const normalized = validateArtifactPath(filename);
  if (normalized === '.') {
    throw new DagentError('WORKSPACE_VIOLATION', 'Uploaded file name cannot be empty.');
  }
  return normalized;
}
