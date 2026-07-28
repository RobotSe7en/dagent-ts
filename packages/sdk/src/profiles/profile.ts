import type { z } from 'zod';

import { agentProfileSchema, type AgentProfile } from '../contracts/profile.js';

export { agentProfileSchema };
export type { AgentProfile };

export function createAgentProfile(input: z.input<typeof agentProfileSchema>): AgentProfile {
  return Object.freeze(agentProfileSchema.parse(input));
}

export function profileTitle(content: string): string {
  for (const line of content.split(/\r?\n/u)) {
    const title = /^#+\s+(.+?)\s*$/u.exec(line.trim());
    if (title !== null) return title[1] ?? '';
  }
  return '';
}

export function renderProfile(profile: AgentProfile): string {
  return profile.content.trim();
}
