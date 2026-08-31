# Runner 和配置

Dagent 有两种配置边界：

1. 直接构造 SDK，或用 SDK runner YAML 加载器。
2. 启动统一 `dagent-ai-app` Host，使用 App YAML。

两者服务对象不同，不应把字段机械混用。

## 直接构造 SDK

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

`workspace` 是默认运行工作区，默认值为 `~/.dagent`；单次 `run()` 可以通过
`workspacePath` 选择其他工作区。`runtimeDirectory` 默认为 `.runtime`，必须是安全相对
路径，并在每个运行工作区内保存私有结果与恢复历史。负责持久化的 Host 应显式传入两者。

目录按需创建：

```text
<runner workspace>/<runtimeDirectory>/conversations/
<run workspace>/<runtimeDirectory>/results/
<run workspace>/<runtimeDirectory>/history/
```

`extraSystemPrompt` 可在新运行前修改，但每次运行开始后会冻结进 V4 plan。resume 使用
checkpoint 中的原值。

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

- `extraRequestArgs` 合并到 Chat Completions 顶层参数。
- `extraBody` 通过 OpenAI client 的扩展 body 发送。
- structured output 使用 `json_object` 请求，并在本地按目标 JSON Schema 校验。
- 非对象工具参数或非法 JSON 会明确失败，不会改写为空对象。
- `outputReserveTokens` 必须小于 context window。

## SDK runner YAML

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

模块、Skill、Profile 和 stdio MCP 的相对路径以 runner YAML 所在目录为基准。

## App YAML

[`examples/dagent.yaml`](../../examples/dagent.yaml) 是统一 Host 的起始配置：

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

启动：

```bash
dagent serve --config ./dagent.yaml --host 127.0.0.1 --port 8000
```

优先级：

1. CLI `--host`、`--port`
2. `DAGENT_HOST`、`DAGENT_PORT`、`DAGENT_DATA_DIR`
3. `OPENAI_BASE_URL`、`OPENAI_MODEL`
4. YAML
5. schema 默认值

Provider 密钥由 `provider.apiKey` 或 `provider.apiKeyEnv` 解析。生产配置建议只使用环境变量。

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

默认容器使用只读 root filesystem、无网络、drop all capabilities、
`no-new-privileges`、有界 CPU/内存/PID 和 64 MiB tmpfs。运行 workspace 读写挂载，
Skill 目录只读挂载。沙箱只作用于 shell capability，不会隔离 Host 中加载的 JavaScript
模块。

## Validation 与 Profiles

Validation 启用后，Runner 在完成 Agent 输出前调用 `ValidatorAgent`。失败可以在
`maxRetries` 内反馈给执行 Agent。内置 profile：

- `conversation`
- `dag_agent`
- `validator_agent`
- `feedback_learner`

自定义 profile 是带 front matter 的 Markdown。SDK `ProfileStore` 从配置目录加载；Host
同时维护 `<dataDirectory>/profiles` managed root。`PromptBuilder` 和 `ProfiledAgent`
适合在代码中组合模板，而不是拼接散落字符串。

`extraSystemPrompt` 不注入 router 或 validator 分类请求；它只作用于 ToolAgent、动态 DAG
规划/re-plan、AutoAgent 选中的执行路径和注册 Agent。

## MCP 与运行时注册

```ts
runner.registerCapability(binding);
runner.registerAgent(agent);
await runner.connectMcp(server);

runner.setValidationEnabled(true);
runner.extraSystemPrompt = 'Updated policy for future runs.';
```

更新只影响之后的新运行。活动运行和 resume 依赖已冻结计划，避免同一审批在不同配置下
执行。

## 生命周期

```ts
await using runner = new Runner(options);
```

或：

```ts
const runner = new Runner(options);
try {
  await runner.run(target, input);
} finally {
  await runner.close();
}
```

`close()` 取消活动运行并关闭 MCP transport。关闭后注册、运行或配置修改会失败。
