import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { DagentError } from '../errors.js';
import { CapabilityCatalog } from './catalog.js';
import { tool } from './tool.js';

describe('CapabilityCatalog enabled overrides', () => {
  it('applies a disabled override to capabilities registered later', () => {
    const catalog = new CapabilityCatalog();
    catalog.setEnabled('tool.deferred', false);
    catalog.register(binding('tool.deferred', 'first'));

    expect(catalog.get('tool.deferred')?.definition.enabled).toBe(false);
    expect(() => catalog.require('tool.deferred')).toThrow(DagentError);
    expect(catalog.disabledIds()).toEqual(['tool.deferred']);
  });

  it('preserves overrides across replacement and can explicitly re-enable', () => {
    const catalog = new CapabilityCatalog([binding('tool.replaceable', 'first')]);
    catalog.setEnabled('tool.replaceable', false);
    catalog.replace(binding('tool.replaceable', 'second'));

    expect(catalog.get('tool.replaceable')?.definition).toMatchObject({
      description: 'second',
      enabled: false,
    });
    expect(catalog.setEnabled('tool.replaceable', true)?.definition.enabled).toBe(true);
    expect(catalog.disabledIds()).toEqual([]);
  });
});

function binding(id: `tool.${string}`, description: string) {
  return tool({
    id,
    description,
    input: z.object({}),
    output: z.string(),
    execute: () => 'ok',
  });
}
