import { createHash } from 'node:crypto';

import type { JsonValue } from '../contracts/common.js';

export function stableStringify(value: JsonValue): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key] ?? null)}`)
    .join(',')}}`;
}

export function sha256(value: JsonValue): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}
