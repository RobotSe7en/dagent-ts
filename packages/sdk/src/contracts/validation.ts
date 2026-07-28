import { z } from 'zod';

import { identifierSchema } from './common.js';
import { agentProfileSchema } from './profile.js';
import { timestampSchema } from './common.js';

export const validationIssueSchema = z
  .object({
    message: z.string().min(1),
    nodeId: identifierSchema.optional(),
  })
  .strict();
export type ValidationIssue = z.infer<typeof validationIssueSchema>;

export const validationResultSchema = z
  .object({
    passed: z.boolean(),
    issues: z.array(validationIssueSchema).readonly().default([]),
    summary: z.string().default(''),
  })
  .strict();
export type ValidationResult = z.infer<typeof validationResultSchema>;

export const validationPolicySchema = z
  .object({
    enabled: z.boolean().default(false),
    maxRetries: z.number().int().nonnegative().default(1),
    profile: agentProfileSchema.optional(),
  })
  .strict()
  .superRefine(({ enabled, profile }, context) => {
    if (enabled && profile === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'An enabled validation policy requires a validator profile.',
        path: ['profile'],
      });
    }
  });
export type ValidationPolicy = z.infer<typeof validationPolicySchema>;

export const validationRecordSchema = z
  .object({
    attempt: z.number().int().nonnegative(),
    result: validationResultSchema,
    createdAt: timestampSchema,
  })
  .strict();
export type ValidationRecord = z.infer<typeof validationRecordSchema>;

export function formatValidationFeedback(validation: ValidationResult): string {
  const lines = ['A validator assessed the result and found issues:'];
  if (validation.summary.length > 0) lines.push(`Summary: ${validation.summary}`);
  for (const issue of validation.issues) {
    lines.push(`- ${issue.nodeId === undefined ? '' : `[${issue.nodeId}] `}${issue.message}`);
  }
  lines.push('', 'Please address these issues.');
  return lines.join('\n');
}
