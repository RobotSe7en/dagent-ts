# Agents

Agent 是不可变声明，不是需要继承的运行时基类。选择 Agent 时先看任务结构，再看审核和
能力边界。

## 选择 Agent

| 模式      | 适合                                     | 主要限制                          |
| --------- | ---------------------------------------- | --------------------------------- |
| ToolAgent | 短任务、交互式工具选择、步骤依赖即时结果 | `maxSteps`                        |
| DagAgent  | 多步骤、并行、先审计划、失败后局部重排   | `maxReplans`                      |
| AutoAgent | 同一入口同时接收简单与复杂任务           | 内嵌 ToolAgent 和 DagAgent 的限制 |
| StaticDag | 宿主已经知道流程，不需要模型规划         | 图本身的节点与循环上限            |

如果工作流可由宿主明确表达，优先静态 DAG；如果只有模型能在看到用户目标后确定流程，
使用 DagAgent。不要为了“Agent 化”而把确定性业务逻辑交给模型。

## ToolAgent

```ts
import { defineToolAgent } from 'dagent-ai';

const assistant = defineToolAgent({
  kind: 'tool-agent',
  id: 'assistant',
  name: 'Assistant',
  description: 'Handles focused workspace tasks.',
  systemPrompt: 'Use tools for external facts and state changes.',
  scope: {
    capabilities: ['tool.read_file', 'tool.write_file'],
    skills: ['writing/release-notes'],
    agents: [],
  },
  reviewLevel: 'risky',
  maxSteps: 20,
});
```

ToolAgent 把 scope 中启用的 capability 暴露给 Provider。模型可以连续调用工具，直到回答、
触发审核、失败或达到 `maxSteps`。

`reviewLevel`：

- `never`：不因策略进入人工审核。
- `risky`：中高风险能力进入审核。
- `always`：能力调用总是进入审核。

审核不会绕过 schema、scope 或边界校验。

## DagAgent

```ts
import { defineDagAgent } from 'dagent-ai';

const planner = defineDagAgent({
  kind: 'dag-agent',
  id: 'planner',
  name: 'Planner',
  description: 'Plans and executes multi-step work.',
  scope: {
    capabilities: ['tool.read_file', 'tool.write_file', 'tool.shell'],
  },
  reviewLevel: 'risky',
  maxReplans: 3,
});
```

DagAgent 先请求结构化计划，再将计划规范化为 canonical `DAGSpec`。运行时校验图、能力白
名单和 dataflow 后才执行。节点失败时，planner 得到已完成节点和失败上下文，可在
`maxReplans` 内提出替代图；已完成节点不会无理由重复执行。

当审核策略要求确认 DAG 时，Runner 返回 `awaiting-review`，并把 proposed graph 写入
checkpoint。恢复时可以批准、拒绝，或为 DAG review 提供 `replacementGraph`。

## AutoAgent

```ts
import { defineAutoAgent } from 'dagent-ai';

const automatic = defineAutoAgent({
  kind: 'auto-agent',
  id: 'automatic',
  name: 'Automatic assistant',
  scope: {},
  reviewLevel: 'risky',
  toolAgent: assistant,
  dagAgent: planner,
});
```

AutoAgent 的 router 只决定使用 ToolAgent 还是 DagAgent。选中后运行时使用对应内嵌 Agent
的 scope 和限制。`Runner.extraSystemPrompt` 应用于被选中的执行 Agent，不用于 router
分类请求，避免宿主回答规则干扰路由。

## 注册与直接运行

```ts
const runner = new Runner({
  provider,
  agents: [assistant, planner],
  workspace: './workspace',
  runtimeDirectory: '.runtime',
});

runner.registerAgent(automatic);
runner.replaceAgent(updatedAgent);
runner.unregisterAgent('old_agent');

await runner.run(assistant, { prompt: 'Summarize README.md' });
```

静态 DAG 的 `agent` 节点按 id 查找 Runner 中已注册的 Agent，因此这类子 Agent 必须先
注册。直接作为 `run()` target 的 Agent 不要求预注册。

重复 `registerAgent()` 会失败；`replaceAgent()` 显式表示宿主接受替换。恢复 checkpoint
使用冻结的 target 和能力定义，不会悄悄采用当前同名 Agent。

## 共享字段

- `id`：稳定标识，必须以字母开头，只包含字母、数字、`_`、`-`
- `name`：面向使用者的名称
- `description`：帮助 router/planner 理解职责
- `systemPrompt`：Agent 自身的持久指令
- `scope`：capabilities、skills、agents 三类白名单
- `reviewLevel`：`never`、`risky`、`always`
- `context`：覆盖默认的上下文压缩策略

`Runner.extraSystemPrompt` 是 Host 级附加提示，不应复制进每个 Agent。它在运行开始时冻结
到 V4 plan；resume 不读取 Runner 当前值。

## 多轮继续

把上次 outcome 中的 `state.conversation` 传给下一次运行：

```ts
const first = await runner.run(assistant, { prompt: 'Remember project Alpha.' });
const second = await runner.run(assistant, {
  prompt: 'Which project did I mention?',
  conversation: first.state.conversation,
});
```

不要把 Provider message 数组或公共 API 的裁剪视图传回 SDK。完整规则见
[会话历史与上下文](conversation-history.md)。
