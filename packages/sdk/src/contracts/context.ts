import { z } from 'zod';

export const contextPolicySchema = z
  .object({
    compactionTriggerRatio: z.number().positive().max(1).default(0.8),
    keepRecentTurns: z.number().int().positive().default(4),
    summaryMaxTokens: z.number().int().min(64).default(1024),
    maxToolResultTokens: z.number().int().min(64).default(2048),
    maxTotalToolResultTokens: z.number().int().min(64).default(8192),
    tokenSafetyMargin: z.number().min(0).max(1).default(0.15),
  })
  .strict()
  .refine(
    ({ maxToolResultTokens, maxTotalToolResultTokens }) =>
      maxToolResultTokens <= maxTotalToolResultTokens,
    {
      message: 'maxToolResultTokens cannot exceed maxTotalToolResultTokens.',
      path: ['maxToolResultTokens'],
    },
  );
export type ContextPolicy = z.infer<typeof contextPolicySchema>;

export const resultStoragePolicySchema = z
  .object({
    maxInlineBytes: z
      .number()
      .int()
      .min(1024)
      .default(256 * 1024),
  })
  .strict();
export type ResultStoragePolicy = z.infer<typeof resultStoragePolicySchema>;

export const contextUsageSchema = z
  .object({
    contextWindowTokens: z.number().int().positive(),
    outputReserveTokens: z.number().int().nonnegative(),
    inputBudgetTokens: z.number().int().positive(),
    estimatedInputTokens: z.number().int().nonnegative(),
    systemTokens: z.number().int().nonnegative().default(0),
    toolSchemaTokens: z.number().int().nonnegative().default(0),
    summaryTokens: z.number().int().nonnegative().default(0),
    historyTokens: z.number().int().nonnegative().default(0),
    toolResultTokens: z.number().int().nonnegative().default(0),
    includedItems: z.number().int().nonnegative().default(0),
    compactedItems: z.number().int().nonnegative().default(0),
    truncatedToolResults: z.number().int().nonnegative().default(0),
    estimator: z.enum(['heuristic', 'custom']).default('heuristic'),
    compactionMethod: z.enum(['none', 'model', 'deterministic-fallback']).default('none'),
    compactionReason: z.string().optional(),
  })
  .strict();
export type ContextUsage = z.infer<typeof contextUsageSchema>;

export const modelTokenUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().default(0),
    outputTokens: z.number().int().nonnegative().default(0),
    reasoningTokens: z.number().int().nonnegative().default(0),
    totalTokens: z.number().int().nonnegative().default(0),
  })
  .strict()
  .refine(
    ({ inputTokens, outputTokens, totalTokens }) => totalTokens >= inputTokens + outputTokens,
    {
      message: 'totalTokens cannot be less than inputTokens + outputTokens.',
      path: ['totalTokens'],
    },
  );
export type ModelTokenUsage = z.infer<typeof modelTokenUsageSchema>;
