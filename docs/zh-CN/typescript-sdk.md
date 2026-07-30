# TypeScript SDK 参考

本页是 `dagent-ai` 公开 surface 的导航，不替代编辑器中的 `.d.ts`。所有入口都是 ESM，
类型与运行时值从同一 exports map 发布。

## 常用入口

```ts
import {
  Runner,
  DagBuilder,
  defineToolAgent,
  defineDagAgent,
  defineAutoAgent,
  defineStaticDag,
  tool,
} from 'dagent-ai';
```

## 包子路径

| 入口                                    | 内容                                                     |
| --------------------------------------- | -------------------------------------------------------- |
| `dagent-ai`                             | Runner、Agent factories、DAG builder、主要能力与契约类型 |
| `dagent-ai/contracts`                   | Zod schemas、契约 helpers 与完整领域类型                 |
| `dagent-ai/config`                      | Runner YAML schema 与 `createRunnerFromConfigFile()`     |
| `dagent-ai/capabilities`                | Catalog、Workspace、内置能力和 tool helpers              |
| `dagent-ai/mcp`                         | MCP schemas、manager 与 capability id helper             |
| `dagent-ai/modules`                     | TypeScript capability module 加载与发现                  |
| `dagent-ai/sandbox`                     | Docker sandbox 与命令执行接口                            |
| `dagent-ai/skills`                      | `SkillStore` 与 Skill capabilities                       |
| `dagent-ai/profiles`                    | Profiles、PromptBuilder、Validator 与反馈学习            |
| `dagent-ai/providers/openai-compatible` | OpenAI Chat Completions 兼容 Provider                    |
| `dagent-ai/testing`                     | 测试 Provider 与 SDK 测试辅助                            |

不要依赖包内未列入 exports map 的路径。

## Runner

```ts
new Runner({
  provider,
  capabilities,
  agents,
  workspace,
  runtimeDirectory,
  extraSystemPrompt,
  limits,
  context,
  resultStorage,
  validation,
  skillRoots,
  managedSkillRoot,
});
```

关键方法：

```ts
runner.run(target, input, options): Promise<RunOutcome>
runner.stream(target, input, options): AsyncIterable<RunEvent>
runner.resume(checkpoint, decision, options): Promise<RunOutcome>
runner.resumeStream(checkpoint, decision, options): AsyncIterable<RunEvent>
runner.cancel(runId, reason?): boolean
runner.checkpoint(runId): RunCheckpoint | undefined
runner.close(): Promise<void>
```

Runner 实现 `AsyncDisposable`，Node.js 24 可使用 `await using`。`workspace` 和
`runtimeDirectory` 是必填 host 选择；不要让 SDK 默认为当前目录中的隐藏路径。

## Agent factories

```ts
defineToolAgent(input): ToolAgent
defineDagAgent(input): DagAgent
defineAutoAgent(input): AutoAgent
defineStaticDag(graph, reviewLevel?): StaticDagTarget
```

Factory 会解析默认值并冻结对象。Agent id 必须匹配
`^[A-Za-z][A-Za-z0-9_-]*$`。

## 类型化能力

```ts
const binding = tool({
  id: 'tool.example',
  input: inputSchema,
  output: outputSchema,
  risk: 'low',
  boundary: {},
  execute: async (input, context) => output,
});
```

`context` 包含 `runId`、`workspacePath`、`AbortSignal` 和 JSON metadata。执行函数应响应
取消信号，且只在 `workspacePath` 内处理本次运行的数据。

`CapabilityCatalog` 支持 register、replace、unregister、lookup 与 scope 过滤。重复注册
会明确失败；运行时替换能力会使旧审核 checkpoint 的定义 fingerprint 失效。

## DagBuilder

```ts
new DagBuilder<TInput, TOutput>({
  id,
  name,
  description?,
  input?,
  output?,
  executionScope?,
});
```

主要方法：

```ts
builder.input(...path)
builder.item(...path)
builder.iteration()
builder.artifact(id, paths, options?)
builder.capability(binding, arguments, options)
builder.agent(agentId, prompt, options)
builder.subgraph(graph, input, options)
builder.map(items, graph, options)
builder.loop(graph, input, until, options)
builder.addEdge(from, to, condition?)
builder.setOutput(value)
builder.build()
```

`NodeRef<T>.output()` 与 `ValueRef<T>.at()` 保留类型关系。map/loop 子图必须使用对应
`executionScope` 才能调用 `item()`；只有 loop scope 可以调用 `iteration()`。

## 公开契约

根入口导出常用类型：

- 会话：`ConversationState`、`ConversationItem`、`Attachment`、`ContentReference`
- DAG：`DAGSpec`、`Artifact`、`ArtifactState`
- 运行：`RunState`、`RunOutcome`、`RunEvent`、`RunCheckpoint`、`ResolvedRunPlan`
- 审核：`PendingReview`、`ReviewDecision`
- 限制：`ExecutionLimits`、`ContextPolicy`、`ResultStoragePolicy`

契约以 Zod schema 作为运行时权威。接收网络、文件或数据库值时，从
`dagent-ai/contracts` 导入相应 schema 解析，避免使用类型断言跳过边界。

## 配置加载

SDK 自带精简 Runner YAML loader：

```ts
import { createRunnerFromConfigFile } from 'dagent-ai';

const runner = await createRunnerFromConfigFile('./runner.yaml', {
  provider,
  workspace: './workspace',
  runtimeDirectory: '.runtime',
});
```

该配置面向嵌入 SDK，字段为 `builtins`、`sandbox`、`skills`、`profiles`、
`validation`、`mcpServers`、`modules`、`agents`、`limits`、`context` 与
`resultStorage`。它不同于 `dagent-ai-app` 的 Host YAML；完整差异见
[Runner 和配置](runner-and-configuration.md)。

## Provider 接口

自定义 Provider 实现：

```ts
interface ChatProvider {
  chat(request: ChatRequest, options?): Promise<ChatResponse>;
  streamChat(request: ChatRequest, options?): AsyncIterable<ChatStreamEvent>;
}
```

Provider adapter 只负责传输和模型协议。对话压缩、能力 scope、DAG 校验、审核与结果存储
属于 Runner，不应复制到 Provider。

`OpenAICompatibleProvider` 另外暴露 `contextWindowTokens` 和 `outputReserveTokens`，Runner
会读取这两个可选实现属性；自定义 Provider 也可以暴露它们，或在 Runner options 中显式
配置对应值。

## 版本说明

0.8.3 使用 V3 `ConversationState`/`RunState` 与 V4
`ResolvedRunPlan`/`RunCheckpoint`。checkpoint 是严格恢复契约，不应手写、裁剪或跨版本
猜测迁移。
