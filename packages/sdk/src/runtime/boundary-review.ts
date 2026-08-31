import { isAbsolute, relative, resolve, sep } from 'node:path';

import type { CapabilityDefinition, CapabilityInvocation } from '../contracts/index.js';

export type BoundaryCheck =
  | { readonly status: 'allowed' }
  | { readonly status: 'review'; readonly paths: readonly string[]; readonly message: string }
  | { readonly status: 'blocked'; readonly message: string };

export function checkInvocationBoundary(
  definition: CapabilityDefinition,
  invocation: CapabilityInvocation,
  workspacePath: string,
  approvedPaths: ReadonlySet<string>,
): BoundaryCheck {
  if (definition.boundary.allowedPaths.length === 0) return { status: 'allowed' };
  const allowed = definition.boundary.allowedPaths.map((path) => resolve(workspacePath, path));
  if (allowed.some((path) => !isWithin(workspacePath, path))) {
    return {
      status: 'blocked',
      message: `Capability '${definition.id}' declares an allowed path outside the run workspace.`,
    };
  }
  const candidates = invocationPathCandidates(invocation);
  const violations: string[] = [];
  for (const candidate of candidates) {
    const target = resolve(workspacePath, candidate);
    if (!isWithin(workspacePath, target)) {
      return {
        status: 'blocked',
        message: `Path '${candidate}' resolves outside the run workspace.`,
      };
    }
    const normalized = relative(workspacePath, target).split(sep).join('/') || '.';
    if (approvedPaths.has(normalized) || allowed.some((path) => isWithin(path, target))) continue;
    violations.push(normalized);
  }
  const paths = [...new Set(violations)].sort();
  return paths.length === 0
    ? { status: 'allowed' }
    : {
        status: 'review',
        paths,
        message: `Paths outside the capability allowlist require review: ${paths.join(', ')}.`,
      };
}

function invocationPathCandidates(invocation: CapabilityInvocation): readonly string[] {
  const values: string[] = [];
  collectNamedPaths(invocation.arguments, values);
  const command = invocation.arguments['command'];
  if (typeof command === 'string') values.push(...commandPathCandidates(command));
  return [...new Set(values)];
}

function collectNamedPaths(value: unknown, paths: string[], key = ''): void {
  if (typeof value === 'string') {
    if (['path', 'source', 'destination', 'file'].includes(key)) paths.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectNamedPaths(item, paths, key);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [childKey, child] of Object.entries(value)) collectNamedPaths(child, paths, childKey);
}

function commandPathCandidates(command: string): readonly string[] {
  const tokens = [...command.matchAll(/(?:^|\s)(?:"([^"]+)"|'([^']+)'|([^\s;&|<>]+))/gu)]
    .map((match) => match[1] ?? match[2] ?? match[3] ?? '')
    .filter((token) => token.length > 0);
  return tokens.slice(1).filter((token) => {
    if (token.startsWith('-') || token.includes('://')) return false;
    return (
      isAbsolute(token) || token.startsWith('./') || token.startsWith('../') || token.includes('/')
    );
  });
}

function isWithin(root: string, target: string): boolean {
  const child = relative(resolve(root), resolve(target));
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}
