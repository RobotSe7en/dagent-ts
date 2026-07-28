import { z } from 'zod';

import { identifierSchema } from './common.js';

export const agentProfileSchema = z
  .object({
    name: identifierSchema,
    description: z.string().default(''),
    content: z.string(),
  })
  .strict();
export type AgentProfile = z.infer<typeof agentProfileSchema>;
