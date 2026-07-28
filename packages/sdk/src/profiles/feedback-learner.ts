import type { JsonValue } from '../contracts/index.js';
import { ProfiledAgent, type ProfiledAgentOptions } from './profiled-agent.js';

export type FeedbackLearning = {
  readonly notes: string;
  readonly preferences: readonly string[];
  readonly evaluationCases: readonly JsonValue[];
};

export class FeedbackLearnerAgent {
  readonly #agent: ProfiledAgent;

  public constructor(options: ProfiledAgentOptions) {
    this.#agent = new ProfiledAgent(options);
  }

  public async learn(input: {
    readonly feedback: string;
    readonly trace?: JsonValue;
    readonly workspacePath?: string;
    readonly signal?: AbortSignal;
  }): Promise<FeedbackLearning> {
    const notes = await this.#agent.runText({
      task: [
        'Feedback:',
        '{{ feedback }}',
        '',
        'Run trace:',
        '{{ trace }}',
        '',
        'Produce learning notes.',
      ].join('\n'),
      variables: {
        feedback: input.feedback,
        trace: input.trace ?? {},
      },
      ...(input.workspacePath === undefined ? {} : { workspacePath: input.workspacePath }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    return { notes, preferences: [], evaluationCases: [] };
  }
}
