import type { ChatProvider, JsonObject } from 'dagent-ai';
import { OpenAICompatibleProvider } from 'dagent-ai/providers/openai-compatible';

import type { AppConfig } from '../config.js';
import type {
  ModelProviderConfig,
  ModelProviderRepository,
  ModelProviderWrite,
} from '../database/model-provider-repository.js';
import type { SwitchableProvider } from './switchable-provider.js';

const CONFIGURED_MODEL_ID = 'configured';

export type ModelProviderPayload = Omit<ModelProviderConfig, 'apiKey'> & {
  readonly editable: boolean;
  readonly deletable: boolean;
  readonly apiKeyConfigured: boolean;
  readonly apiKeySaved: boolean;
};

export type ModelProviderInput = {
  readonly id: string;
  readonly name: string;
  readonly baseURL: string;
  readonly model: string;
  readonly apiKey?: string | undefined;
  readonly apiKeyAction?: 'preserve' | 'replace' | 'clear';
  readonly apiKeyEnv?: string | undefined;
  readonly timeoutMs: number;
  readonly contextWindowTokens: number;
  readonly outputReserveTokens: number;
  readonly reasoning?: ModelProviderConfig['reasoning'] | undefined;
  readonly streamIncludeUsage: boolean;
  readonly extraRequestArgs: JsonObject;
  readonly extraBody: JsonObject;
};

export class ModelProviderServiceError extends Error {
  public constructor(
    public readonly code:
      'MODEL_ACTIVE' | 'MODEL_ALREADY_EXISTS' | 'MODEL_IMMUTABLE' | 'MODEL_NOT_FOUND',
    message: string,
    public readonly statusCode: 400 | 404 | 409,
  ) {
    super(message);
    this.name = 'ModelProviderServiceError';
  }
}

export class ModelProviderService {
  public constructor(
    private readonly repository: ModelProviderRepository,
    private readonly provider: SwitchableProvider,
    private readonly configuredProvider: ChatProvider,
    private readonly config: AppConfig['provider'],
  ) {}

  public async initialize(): Promise<void> {
    await this.repository.upsertConfigured({
      id: CONFIGURED_MODEL_ID,
      name: 'Configured model',
      source: 'config',
      baseURL: this.config.baseURL,
      model: this.config.model,
      ...(this.config.apiKey === undefined ? {} : { apiKey: this.config.apiKey }),
      apiKeyEnv: this.config.apiKeyEnv,
      timeoutMs: 60_000,
      contextWindowTokens: this.config.contextWindowTokens,
      outputReserveTokens: this.config.outputReserveTokens,
      ...(this.config.reasoning === undefined ? {} : { reasoning: this.config.reasoning }),
      streamIncludeUsage: this.config.streamIncludeUsage,
      extraRequestArgs: this.config.extraRequestArgs,
      extraBody: this.config.extraBody,
    });
    const active =
      (await this.repository.list()).find((model) => model.active) ??
      (await this.repository.activate(CONFIGURED_MODEL_ID));
    if (active !== undefined) this.#use(active);
  }

  public async list(): Promise<{
    readonly models: readonly ModelProviderPayload[];
    readonly activeModelId: string;
  }> {
    return {
      models: (await this.repository.list()).map(toPayload),
      activeModelId: this.provider.activeId,
    };
  }

  public async create(input: ModelProviderInput): Promise<ModelProviderPayload> {
    if ((await this.repository.get(input.id)) !== undefined) {
      throw new ModelProviderServiceError(
        'MODEL_ALREADY_EXISTS',
        `Model provider '${input.id}' already exists.`,
        409,
      );
    }
    const stored = await this.repository.create(toWrite(input, 'managed', input.apiKey));
    if (stored.active) this.#use(stored);
    return toPayload(stored);
  }

  public async update(id: string, input: ModelProviderInput): Promise<ModelProviderPayload> {
    const existing = await this.#managed(id);
    if (input.id !== id) {
      throw new ModelProviderServiceError(
        'MODEL_IMMUTABLE',
        `Model config id '${input.id}' does not match route id '${id}'.`,
        400,
      );
    }
    const apiKey = resolveApiKey(input, existing.apiKey);
    const updated = await this.repository.update(id, toWrite(input, 'managed', apiKey));
    if (updated === undefined) {
      throw new ModelProviderServiceError(
        'MODEL_NOT_FOUND',
        `Model provider '${id}' was not found.`,
        404,
      );
    }
    if (updated.active) this.#use(updated);
    return toPayload(updated);
  }

  public async activate(id: string): Promise<ModelProviderPayload> {
    const activated = await this.repository.activate(id);
    if (activated === undefined) {
      throw new ModelProviderServiceError(
        'MODEL_NOT_FOUND',
        `Model provider '${id}' was not found.`,
        404,
      );
    }
    this.#use(activated);
    return toPayload(activated);
  }

  public async delete(id: string): Promise<void> {
    const existing = await this.repository.get(id);
    if (existing === undefined) {
      throw new ModelProviderServiceError(
        'MODEL_NOT_FOUND',
        `Model provider '${id}' was not found.`,
        404,
      );
    }
    if (existing.source === 'config') {
      throw new ModelProviderServiceError(
        'MODEL_IMMUTABLE',
        'The configured model cannot be deleted.',
        400,
      );
    }
    if (existing.active) {
      throw new ModelProviderServiceError(
        'MODEL_ACTIVE',
        'The active model provider cannot be deleted.',
        409,
      );
    }
    await this.repository.delete(id);
  }

  async #managed(id: string): Promise<ModelProviderConfig> {
    const existing = await this.repository.get(id);
    if (existing === undefined) {
      throw new ModelProviderServiceError(
        'MODEL_NOT_FOUND',
        `Model provider '${id}' was not found.`,
        404,
      );
    }
    if (existing.source !== 'managed') {
      throw new ModelProviderServiceError(
        'MODEL_IMMUTABLE',
        'The configured model is managed through the application config.',
        400,
      );
    }
    return existing;
  }

  #use(config: ModelProviderConfig): void {
    if (config.source === 'config') {
      this.provider.use(config.id, this.configuredProvider);
      return;
    }
    this.provider.use(
      config.id,
      new OpenAICompatibleProvider({
        baseURL: config.baseURL,
        model: config.model,
        ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
        ...(config.apiKeyEnv === undefined ? {} : { apiKeyEnv: config.apiKeyEnv }),
        timeoutMs: config.timeoutMs,
        contextWindowTokens: config.contextWindowTokens,
        outputReserveTokens: config.outputReserveTokens,
        ...(config.reasoning === undefined
          ? {}
          : { reasoning: normalizeReasoning(config.reasoning) }),
        streamIncludeUsage: config.streamIncludeUsage,
        extraBody: config.extraBody,
        extraRequestArgs: config.extraRequestArgs,
      }),
    );
  }
}

function toWrite(
  input: ModelProviderInput,
  source: ModelProviderWrite['source'],
  apiKey: string | undefined,
): ModelProviderWrite {
  if (input.outputReserveTokens >= input.contextWindowTokens) {
    throw new TypeError('outputReserveTokens must be smaller than contextWindowTokens.');
  }
  return {
    id: input.id,
    name: input.name,
    source,
    baseURL: input.baseURL,
    model: input.model,
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(input.apiKeyEnv === undefined ? {} : { apiKeyEnv: input.apiKeyEnv }),
    timeoutMs: input.timeoutMs,
    contextWindowTokens: input.contextWindowTokens,
    outputReserveTokens: input.outputReserveTokens,
    ...(input.reasoning === undefined ? {} : { reasoning: input.reasoning }),
    streamIncludeUsage: input.streamIncludeUsage,
    extraRequestArgs: input.extraRequestArgs,
    extraBody: input.extraBody,
  };
}

function resolveApiKey(
  input: ModelProviderInput,
  existing: string | undefined,
): string | undefined {
  switch (input.apiKeyAction ?? 'preserve') {
    case 'clear':
      return undefined;
    case 'replace':
      return input.apiKey;
    case 'preserve':
      return existing;
  }
}

function toPayload(config: ModelProviderConfig): ModelProviderPayload {
  const visible = { ...config };
  delete visible.apiKey;
  return {
    ...visible,
    editable: config.source === 'managed',
    deletable: config.source === 'managed' && !config.active,
    apiKeyConfigured:
      config.apiKey !== undefined ||
      (config.apiKeyEnv !== undefined && (process.env[config.apiKeyEnv]?.length ?? 0) > 0),
    apiKeySaved: config.apiKey !== undefined,
  };
}

function normalizeReasoning(reasoning: NonNullable<ModelProviderConfig['reasoning']>) {
  return {
    ...(reasoning.enabled === undefined ? {} : { enabled: reasoning.enabled }),
    ...(reasoning.effort === undefined ? {} : { effort: reasoning.effort }),
    ...(reasoning.budgetTokens === undefined ? {} : { budgetTokens: reasoning.budgetTokens }),
    ...(reasoning.capture === undefined ? {} : { capture: reasoning.capture }),
  };
}
