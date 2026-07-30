# Runner and Configuration

Dagent has two configuration boundaries:

1. Construct the SDK directly or use the SDK Runner YAML loader.
2. Start the unified `dagent-ai-app` host with App YAML.

They serve different owners; do not mix their fields mechanically.

## Direct SDK Construction

```ts
const runner = new Runner({
  provider,
  capabilities: [/* bindings */],
  agents: [/* declarations */],
  workspace: './workspace',
  runtimeDirectory: '.runtime',
  extraSystemPrompt: 'Follow the host response policy.',
  limits: {
    maxModelCalls: 100,
    maxCapabilityCalls: 200,
    maxNodeExecutions: 500,
    maxDurationMs: 300_000,
    maxConcurrency: 8,
  },
  context: {
    compactionTriggerRatio: 0.8,
    keepRecentTurns: 4,
    summaryMaxTokens: 1024,
    maxToolResultTokens: 2048,
    maxTotalToolResultTokens: 8192,
    tokenSafetyMargin: 0.15,
  },
  resultStorage: {
    maxInlineBytes: 256 * 1024,
  },
  validation: {
    enabled: false,
    maxRetries: 1,
  },
});
```

`workspace` is the default run workspace. A single `run()` can select another workspace with
`workspacePath`. `runtimeDirectory` must be a safe relative path and stores private results and
resumption history in every run workspace.

Directories are created lazily:

```text
<runner workspace>/<runtimeDirectory>/conversations/
<run workspace>/<runtimeDirectory>/results/
<run workspace>/<runtimeDirectory>/history/
```

`extraSystemPrompt` can change before a new run, but its initial value is frozen into the V4 plan.
Resumption uses the checkpoint value.

## Provider

```ts
const provider = new OpenAICompatibleProvider({
  baseURL: 'https://api.openai.com/v1',
  model: 'gpt-5-mini',
  apiKeyEnv: 'OPENAI_API_KEY',
  timeoutMs: 60_000,
  contextWindowTokens: 128_000,
  outputReserveTokens: 8192,
  streamIncludeUsage: false,
  reasoning: {
    enabled: true,
    effort: 'medium',
    capture: 'field-and-tags',
  },
  extraRequestArgs: {},
  extraBody: {},
});
```

- `extraRequestArgs` merges into top-level Chat Completions parameters.
- `extraBody` is sent through the OpenAI client's extension body.
- Structured output uses a `json_object` request and local target JSON Schema validation.
- Non-object tool arguments and invalid JSON fail explicitly; they are not rewritten to `{}`.
- `outputReserveTokens` must be smaller than the context window.

## SDK Runner YAML

```yaml
builtins:
  - files
  - shell
  - memory

sandbox:
  enabled: false

skills:
  roots:
    - ./skills
  managedRoot: ./.managed-skills

profiles:
  directory: ./profiles

validation:
  enabled: false
  maxRetries: 1
  profile: validator_agent

mcpServers: []
modules: []
agents: []

limits:
  maxConcurrency: 8

context:
  keepRecentTurns: 4

resultStorage:
  maxInlineBytes: 262144

contextWindowTokens: 128000
outputReserveTokens: 8192
```

```ts
const runner = await createRunnerFromConfigFile('./runner.yaml', {
  provider,
  workspace: './workspace',
  runtimeDirectory: '.runtime',
});
```

Relative module, Skill, profile, and stdio MCP paths resolve from the Runner YAML directory.

## App YAML

[`examples/dagent.yaml`](../../examples/dagent.yaml) is a starting configuration for the unified
host:

```yaml
host: 127.0.0.1
port: 8000
dataDirectory: ./.dagent-ts
runtimeDirectory: .runtime

provider:
  baseURL: https://api.openai.com/v1
  model: gpt-5-mini
  apiKeyEnv: OPENAI_API_KEY
  timeoutMs: 60000
  streamIncludeUsage: false
  contextWindowTokens: 128000
  outputReserveTokens: 8192
  extraRequestArgs: {}
  extraBody: {}

sandbox:
  enabled: false

skillRoots:
  - ./skills

profiles:
  directory: ./profiles

validation:
  enabled: false
  maxRetries: 1
  profile: validator_agent

mcpServers: []
capabilityModules: []
```

Start it:

```bash
dagent serve --config ./dagent.yaml --host 127.0.0.1 --port 8000
```

Precedence:

1. CLI `--host` and `--port`
2. `DAGENT_HOST`, `DAGENT_PORT`, and `DAGENT_DATA_DIR`
3. `OPENAI_BASE_URL` and `OPENAI_MODEL`
4. YAML
5. schema defaults

Provider credentials resolve from `provider.apiKey` or `provider.apiKeyEnv`. Production
configuration should use environment variables instead of literal secrets.

## Docker Sandbox

```yaml
sandbox:
  enabled: true
  docker:
    image: node:24-alpine
    network: false
    memory: 512m
    cpus: 1
    pidsLimit: 256
    timeoutMs: 60000
    environment: {}
    skillDirectories: []
```

The default container has a read-only root filesystem, no network, all capabilities dropped,
`no-new-privileges`, bounded CPU/memory/PIDs, and a 64 MiB tmpfs. The run workspace is mounted
read-write, while Skill directories are mounted read-only. The sandbox covers shell capability
execution; it does not isolate JavaScript modules loaded inside the host process.

## Validation and Profiles

When validation is enabled, Runner invokes `ValidatorAgent` before completing Agent output.
Failures can be fed back to the execution Agent within `maxRetries`. Built-in profiles:

- `conversation`
- `dag_agent`
- `validator_agent`
- `feedback_learner`

A custom profile is Markdown with front matter. SDK `ProfileStore` loads from the configured
directory. The host also maintains a `<dataDirectory>/profiles` managed root. `PromptBuilder` and
`ProfiledAgent` compose templates in code without scattering string concatenation.

`extraSystemPrompt` is not injected into router or validator classification requests. It applies
only to ToolAgent, dynamic DAG planning and re-planning, the selected AutoAgent path, and registered
Agents.

## MCP and Runtime Registration

```ts
runner.registerCapability(binding);
runner.registerAgent(agent);
await runner.connectMcp(server);

runner.setValidationEnabled(true);
runner.extraSystemPrompt = 'Updated policy for future runs.';
```

Updates affect only future runs. Active execution and resumption depend on a frozen plan, so the
same approval cannot execute under different configuration.

## Lifecycle

```ts
await using runner = new Runner(options);
```

Or:

```ts
const runner = new Runner(options);
try {
  await runner.run(target, input);
} finally {
  await runner.close();
}
```

`close()` cancels active runs and closes MCP transports. Registration, execution, and
configuration changes fail after Runner closes.
