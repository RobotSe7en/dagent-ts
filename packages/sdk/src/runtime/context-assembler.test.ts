import { describe, expect, it } from 'vitest';

import {
  contextPolicySchema,
  conversationStateSchema,
  inlineContent,
  toolResultMessageSchema,
  userMessageSchema,
} from '../contracts/index.js';
import { ContextAssembler, type TokenCounter } from './context-assembler.js';

const characterCounter: TokenCounter = {
  countText: (text) => text.length,
  countRequest: (messages, tools) => JSON.stringify({ messages, tools }).length,
};

describe('ContextAssembler', () => {
  it.each([0, 1, 7, 16, 32])('truncates text within an exact token budget of %s', (budget) => {
    const assembler = new ContextAssembler({
      contextWindowTokens: 1024,
      outputReserveTokens: 128,
      tokenCounter: characterCounter,
    });

    const [content, truncated] = assembler.truncateText(
      'abcdefghijklmnopqrstuvwxyz'.repeat(4),
      budget,
    );

    expect(content.length).toBeLessThanOrEqual(budget);
    expect(truncated).toBe(true);
  });

  it('compacts old turns while preserving recent turns', async () => {
    const items = Array.from({ length: 6 }, (_, index) =>
      userMessageSchema.parse({ type: 'user', content: `turn-${index}-${'x'.repeat(40)}` }),
    );
    const conversation = conversationStateSchema.parse({
      schemaVersion: 3,
      items,
    });
    const assembler = new ContextAssembler({
      contextWindowTokens: 1024,
      outputReserveTokens: 128,
      tokenCounter: characterCounter,
    });

    const prepared = await assembler.prepare({
      systemMessage: { role: 'system', content: 'system' },
      conversation,
      policy: contextPolicySchema.parse({
        compactionTriggerRatio: 0.1,
        keepRecentTurns: 2,
      }),
      compact: async (_previous, compacted) => ({
        content: 'summary',
        sourceItemCount: compacted.length,
        method: 'model',
      }),
    });

    expect(prepared.conversation.summary?.content).toBe('summary');
    expect(prepared.conversation.items).toHaveLength(2);
    expect(prepared.usage.compactedItems).toBe(4);
    expect(prepared.usage.compactionMethod).toBe('model');
  });

  it('uses a deterministic fallback and bounds tool results', async () => {
    const conversation = conversationStateSchema.parse({
      schemaVersion: 3,
      items: [
        userMessageSchema.parse({ type: 'user', content: 'first' }),
        toolResultMessageSchema.parse({
          type: 'tool-result',
          callId: 'call-1',
          name: 'tool.long',
          status: 'completed',
          content: inlineContent('a'.repeat(500)),
        }),
        userMessageSchema.parse({ type: 'user', content: 'second' }),
      ],
    });
    const assembler = new ContextAssembler({
      contextWindowTokens: 1024,
      outputReserveTokens: 128,
      tokenCounter: characterCounter,
    });
    const prepared = await assembler.prepare({
      systemMessage: { role: 'system', content: 'system' },
      conversation,
      policy: contextPolicySchema.parse({
        compactionTriggerRatio: 0.1,
        keepRecentTurns: 1,
        maxToolResultTokens: 64,
        maxTotalToolResultTokens: 64,
      }),
      compact: async () => {
        throw new Error('offline');
      },
    });
    expect(prepared.usage.compactionMethod).toBe('deterministic-fallback');
    expect(prepared.conversation.summary?.fallbackReason).toContain('offline');
  });
});
