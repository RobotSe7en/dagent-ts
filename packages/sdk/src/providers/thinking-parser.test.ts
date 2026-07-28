import { describe, expect, it } from 'vitest';

import { ThinkingStreamParser } from './thinking-parser.js';

describe('ThinkingStreamParser', () => {
  it('recognizes delimiters split across arbitrary chunks', () => {
    const parser = new ThinkingStreamParser();
    const parts = [
      ...parser.feed('before<th'),
      ...parser.feed('ink>private</thi'),
      ...parser.feed('nk>after'),
      ...parser.finish(),
    ];

    expect(
      parts
        .filter(({ channel }) => channel === 'content')
        .map(({ content }) => content)
        .join(''),
    ).toBe('beforeafter');
    expect(
      parts
        .filter(({ channel }) => channel === 'reasoning')
        .map(({ content }) => content)
        .join(''),
    ).toBe('private');
  });

  it('preserves input when tag capture is disabled', () => {
    const parser = new ThinkingStreamParser(false);
    expect(parser.feed('<think>visible</think>')).toEqual([
      { channel: 'content', content: '<think>visible</think>' },
    ]);
    expect(parser.finish()).toEqual([]);
  });

  it('flushes an unterminated reasoning section as reasoning', () => {
    const parser = new ThinkingStreamParser();
    const parts = [...parser.feed('<think>unfinished'), ...parser.finish()];
    expect(parts.map(({ channel }) => channel)).toEqual(['reasoning', 'reasoning']);
    expect(parts.map(({ content }) => content).join('')).toBe('unfinished');
  });
});
