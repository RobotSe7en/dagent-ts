import { describe, expect, it } from 'vitest';

import { mcpCapabilityId } from './manager.js';

describe('MCP capability identifiers', () => {
  it('keeps already-safe names readable and stable', () => {
    expect(mcpCapabilityId('filesystem', 'read_file')).toBe('mcp.filesystem.read_file');
  });

  it('adds a stable digest when an MCP tool name needs normalization', () => {
    const first = mcpCapabilityId('search', 'lookup.tool');
    const second = mcpCapabilityId('search', 'lookup/tool');

    expect(first).toMatch(/^mcp\.search\.lookup_tool_[a-f0-9]{8}$/);
    expect(mcpCapabilityId('search', 'lookup.tool')).toBe(first);
    expect(second).not.toBe(first);
  });

  it('cannot collide an unsafe tool name with an already-safe name', () => {
    expect(mcpCapabilityId('search', 'lookup.tool')).not.toBe(
      mcpCapabilityId('search', 'lookup_tool'),
    );
  });
});
