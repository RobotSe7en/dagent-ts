import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { CapabilityBinding } from '../capabilities/index.js';
import { isCapabilityBinding } from '../capabilities/index.js';
import { DagentError } from '../errors.js';
import { sha256 } from '../internal/stable-json.js';
import { compileCapabilityModuleDefinition, isCapabilityModuleDefinition } from './definition.js';

export type CapabilityModuleSpec = {
  readonly path: string;
  readonly exports: readonly string[];
  readonly root?: string;
};

export type CapabilityModuleExport = {
  readonly name: string;
  readonly capabilityIds: readonly string[];
};

const supportedExtensions = new Set(['.js', '.mjs', '.ts', '.mts']);

export async function loadCapabilityModule(
  spec: CapabilityModuleSpec,
): Promise<readonly CapabilityBinding[]> {
  if (spec.exports.length === 0 || new Set(spec.exports).size !== spec.exports.length) {
    throw new DagentError(
      'INVALID_INPUT',
      'A capability module needs unique, explicit export names.',
    );
  }
  const { path, namespace } = await importModule(spec.path, spec.root);
  const bindings: CapabilityBinding[] = [];
  for (const exportName of spec.exports) {
    const exported = namespace[exportName];
    if (isCapabilityModuleDefinition(exported)) {
      bindings.push(...compileCapabilityModuleDefinition(exported, `module:${path}#${exportName}`));
      continue;
    }
    const values = Array.isArray(exported) ? exported : [exported];
    if (values.length === 0 || values.some((value) => !isCapabilityBinding(value))) {
      throw new DagentError(
        'INVALID_INPUT',
        `Export '${exportName}' is not a capability binding, binding array, or module definition.`,
      );
    }
    bindings.push(...(values as CapabilityBinding[]));
  }
  const duplicate = duplicateCapabilityId(bindings);
  if (duplicate !== undefined) {
    throw new DagentError(
      'INVALID_INPUT',
      `Capability '${duplicate}' is exported more than once by '${path}'.`,
    );
  }
  return Object.freeze(bindings);
}

export async function discoverCapabilityModuleExports(
  pathValue: string,
  root?: string,
): Promise<readonly CapabilityModuleExport[]> {
  const { path, namespace } = await importModule(pathValue, root);
  const discovered: CapabilityModuleExport[] = [];
  for (const [name, exported] of Object.entries(namespace)) {
    if (isCapabilityModuleDefinition(exported)) {
      const bindings = compileCapabilityModuleDefinition(exported, `module:${path}#${name}`);
      discovered.push({
        name,
        capabilityIds: bindings.map(({ definition }) => definition.id),
      });
      continue;
    }
    const values = Array.isArray(exported) ? exported : [exported];
    if (values.length > 0 && values.every((value) => isCapabilityBinding(value))) {
      discovered.push({
        name,
        capabilityIds: values.map((value) => value.definition.id),
      });
    }
  }
  return discovered.sort((left, right) => left.name.localeCompare(right.name));
}

async function importModule(
  pathValue: string,
  root?: string,
): Promise<{ readonly path: string; readonly namespace: Record<string, unknown> }> {
  const candidate = resolve(pathValue);
  if (root !== undefined) assertWithin(resolve(root), candidate);
  if (!supportedExtensions.has(extname(candidate))) {
    throw new DagentError(
      'INVALID_INPUT',
      `Unsupported capability module extension '${extname(candidate)}'.`,
    );
  }
  const path = await realpath(candidate);
  if (!(await stat(path)).isFile()) {
    throw new DagentError('INVALID_INPUT', 'Capability module path is not a file.');
  }
  if (root !== undefined) assertWithin(await realpath(resolve(root)), path);
  const digest = sha256(await readFile(path, 'utf8'));
  const namespace = (await import(`${pathToFileURL(path).href}?dagent=${digest}`)) as Record<
    string,
    unknown
  >;
  return { path, namespace };
}

function duplicateCapabilityId(bindings: readonly CapabilityBinding[]): string | undefined {
  const seen = new Set<string>();
  for (const binding of bindings) {
    if (seen.has(binding.definition.id)) return binding.definition.id;
    seen.add(binding.definition.id);
  }
  return undefined;
}

function assertWithin(root: string, candidate: string): void {
  const path = relative(root, candidate);
  if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new DagentError(
      'WORKSPACE_VIOLATION',
      `Capability module '${candidate}' is outside '${root}'.`,
    );
  }
}
