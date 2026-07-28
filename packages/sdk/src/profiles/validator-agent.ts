import { z } from 'zod';

import {
  validationIssueSchema,
  validationResultSchema,
  type ValidationResult,
} from '../contracts/index.js';
import {
  AgentResponseFormatError,
  ProfiledAgent,
  type ProfiledAgentOptions,
} from './profiled-agent.js';

const validatorPayloadSchema = z
  .object({
    passed: z.boolean(),
    issues: z.array(validationIssueSchema).default([]),
    summary: z.string().default(''),
  })
  .loose();

export class ValidatorAgent {
  readonly #agent: ProfiledAgent;

  public constructor(options: ProfiledAgentOptions) {
    this.#agent = new ProfiledAgent(options);
  }

  public async validate(input: {
    readonly userRequest: string;
    readonly finalAnswer: string;
    readonly executionContext?: string;
    readonly workspacePath?: string;
    readonly signal?: AbortSignal;
  }): Promise<ValidationResult> {
    const sections = [`User request:\n${input.userRequest}`];
    if (input.executionContext?.trim()) {
      sections.push(`Execution context:\n${input.executionContext}`);
    }
    sections.push(
      `Final answer given to user:\n${input.finalAnswer || '(no answer provided)'}`,
      "Validate whether the final answer sufficiently addresses the user's request.",
      'Return only a JSON object matching the provided response schema.',
    );
    try {
      const payload = validatorPayloadSchema.parse(
        await this.#agent.runJson({
          task: sections.join('\n\n'),
          ...(input.workspacePath === undefined ? {} : { workspacePath: input.workspacePath }),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        }),
      );
      const issues =
        !payload.passed && payload.issues.length === 0
          ? [{ message: "The answer does not sufficiently address the user's request." }]
          : payload.issues;
      return validationResultSchema.parse({ ...payload, issues });
    } catch (error) {
      if (!(error instanceof AgentResponseFormatError) && !(error instanceof z.ZodError)) {
        throw error;
      }
      return validationResultSchema.parse({
        passed: true,
        issues: [],
        summary:
          'Automated result validation was skipped because the validator returned invalid JSON.',
      });
    }
  }
}
