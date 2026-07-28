import { describe, expect, it } from 'vitest';

import { decodeRunInput, runInputSchema } from './run-input.js';

describe('V3 agent run input', () => {
  it('decodes typed uploads without retaining transport base64 in the runtime contract', () => {
    const decoded = decodeRunInput(
      runInputSchema.parse({
        prompt: 'Inspect the file.',
        uploads: [
          {
            filename: 'spec.md',
            contentBase64: Buffer.from('# requirement').toString('base64'),
          },
        ],
      }),
    );

    expect(decoded).toMatchObject({
      prompt: 'Inspect the file.',
      uploads: [{ filename: 'spec.md' }],
    });
    if (!('prompt' in decoded)) return;
    expect(Buffer.from(decoded.uploads?.[0]?.content ?? []).toString('utf8')).toBe('# requirement');
  });

  it('rejects malformed base64 and unknown transport fields', () => {
    expect(() =>
      runInputSchema.parse({
        prompt: 'Inspect.',
        uploads: [{ filename: 'bad.txt', contentBase64: 'not base64!' }],
      }),
    ).toThrow();
    expect(() => runInputSchema.parse({ prompt: 'Inspect.', messages: [] })).toThrow();
  });
});
