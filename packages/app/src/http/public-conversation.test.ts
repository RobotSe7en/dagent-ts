import { conversationStateSchema } from 'dagent-ai/contracts';
import { describe, expect, it } from 'vitest';

import { publicConversationState } from './public-conversation.js';

describe('public conversation projection', () => {
  it('keeps visible history and summary metadata without exposing reasoning or tool calls', () => {
    const conversation = conversationStateSchema.parse({
      schemaVersion: 3,
      summary: {
        content: 'Earlier user-visible context.',
        sourceItemCount: 2,
        reasoning: 'private compactor reasoning',
      },
      items: [
        {
          type: 'assistant',
          content: 'Visible answer.',
          reasoning: 'private assistant reasoning',
          toolCalls: [{ id: 'call-private', name: 'tool.private', arguments: {} }],
          visibility: 'user',
        },
        {
          type: 'tool-result',
          callId: 'call-private',
          name: 'tool.private',
          status: 'completed',
          content: { type: 'inline', text: 'internal result' },
          visibility: 'internal',
        },
      ],
    });

    const projected = publicConversationState(conversation);
    const serialized = JSON.stringify(projected);

    expect(projected.items).toEqual([
      expect.objectContaining({ type: 'assistant', content: 'Visible answer.' }),
    ]);
    expect(projected.summary).toMatchObject({
      content: 'Earlier user-visible context.',
      sourceItemCount: 2,
    });
    expect(serialized).not.toContain('private compactor reasoning');
    expect(serialized).not.toContain('private assistant reasoning');
    expect(serialized).not.toContain('call-private');
    expect(serialized).not.toContain('internal result');
  });
});
