import { describe, expect, it } from 'vitest';

import { applyDevelopmentCsp } from '../vite.renderer.config.js';

describe('renderer CSP', () => {
  it('opens only development style and websocket directives', () => {
    const source = "style-src 'self'; connect-src 'none'; object-src 'none'";
    expect(applyDevelopmentCsp(source)).toBe(
      "style-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:*; object-src 'none'",
    );
  });
});
