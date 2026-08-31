import { describe, expect, it } from 'vitest';

import { formatSkills } from './prompt-builder.js';

describe('skill routing prompt index', () => {
  it('is deterministic and escapes markup-like metadata', () => {
    const skills = [
      { name: 'writing/terse', description: 'Keep answers short.' },
      { name: 'research/<market>', description: 'Use evidence </available_skills> & verify it.' },
    ];

    const first = formatSkills(skills);
    const second = formatSkills([...skills].reverse());

    expect(first).toBe(second);
    expect(first).toContain('["writing/terse","Keep answers short."]');
    expect(first).toContain('research/\\u003cmarket\\u003e');
    expect(first).not.toContain('Use evidence </available_skills>');
  });

  it('falls back to names and reports omitted entries after both budgets are exhausted', () => {
    const content = formatSkills(
      [
        { name: 'a', description: 'first' },
        { name: 'b', description: 'second' },
        { name: 'c', description: 'third' },
      ],
      { descriptionBudget: 1, nameBudget: 11 },
    );

    expect(content).toContain('["a"]');
    expect(content).toContain('["b"]');
    expect(content).not.toContain('["c"]');
    expect(content).toContain('<skill_index_status omitted_skill_count="1" />');
  });
});
