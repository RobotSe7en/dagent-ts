import type { ChatProvider } from '../providers/provider.js';
import type { JsonObject, JsonValue } from '../contracts/index.js';
import { DagentError } from '../errors.js';
import type { AgentProfile } from './profile.js';
import { PromptBuilder, type PromptRequest, type PromptVariables } from './prompt-builder.js';

export type ProfiledAgentOptions = {
  readonly provider: ChatProvider;
  readonly profile: AgentProfile;
  readonly promptBuilder?: PromptBuilder;
  readonly reserveModelCall?: (signal?: AbortSignal) => void;
};

export type ProfiledAgentRunOptions = Omit<PromptRequest, 'profile' | 'task' | 'variables'> & {
  readonly task: string;
  readonly variables?: PromptVariables;
  readonly signal?: AbortSignal;
};

export class ProfiledAgent {
  readonly #provider: ChatProvider;
  readonly #profile: AgentProfile;
  readonly #promptBuilder: PromptBuilder;
  readonly #reserveModelCall: ((signal?: AbortSignal) => void) | undefined;

  public constructor(options: ProfiledAgentOptions) {
    this.#provider = options.provider;
    this.#profile = options.profile;
    this.#promptBuilder = options.promptBuilder ?? new PromptBuilder();
    this.#reserveModelCall = options.reserveModelCall;
  }

  public async runText(options: ProfiledAgentRunOptions): Promise<string> {
    this.#reserveModelCall?.(options.signal);
    const response = await this.#provider.chat(
      {
        messages: this.#promptBuilder.build({
          profile: this.#profile,
          task: options.task,
          ...(options.variables === undefined ? {} : { variables: options.variables }),
          ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
          ...(options.context === undefined ? {} : { context: options.context }),
          ...(options.workspacePath === undefined ? {} : { workspacePath: options.workspacePath }),
        }),
      },
      options.signal === undefined ? {} : { signal: options.signal },
    );
    return response.content;
  }

  public async runJson(options: ProfiledAgentRunOptions): Promise<JsonObject> {
    return extractJsonObject(await this.runText(options));
  }
}

export class AgentResponseFormatError extends DagentError {
  public constructor(message: string) {
    super('PROVIDER_FAILED', message);
    this.name = 'AgentResponseFormatError';
  }
}

export function extractJsonObject(content: string): JsonObject {
  const stripped = stripMarkdownFence(content.trim());
  const direct = parseJson(stripped);
  if (direct !== undefined) return requireJsonObject(direct);

  for (let start = stripped.indexOf('{'); start >= 0; start = stripped.indexOf('{', start + 1)) {
    const end = completeObjectEnd(stripped, start);
    if (end === undefined) continue;
    const parsed = parseJson(stripped.slice(start, end));
    if (parsed !== undefined) return requireJsonObject(parsed);
  }
  throw new AgentResponseFormatError('Agent response did not contain a JSON object.');
}

function stripMarkdownFence(content: string): string {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(content);
  return match?.[1] ?? content;
}

function parseJson(content: string): JsonValue | undefined {
  try {
    return JSON.parse(content) as JsonValue;
  } catch {
    return undefined;
  }
}

function requireJsonObject(value: JsonValue): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentResponseFormatError('Agent response JSON must be an object.');
  }
  return value;
}

function completeObjectEnd(content: string, start: number): number | undefined {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < content.length; index += 1) {
    const character = content[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return undefined;
}
