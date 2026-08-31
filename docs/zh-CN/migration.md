# 迁移说明

本仓库的 TypeScript 发布线从 0.8 开始。Python Dagent 的早期版本历史不在这里重复；从
Python 迁移时请按行为契约重写 Host 和业务代码，不要逐符号替换。

## 当前发布线

| 版本  | 契约                                                         |
| ----- | ------------------------------------------------------------ |
| 0.9.5 | 可观察设计流、可见设计响应与 DagentWork 桌面端               |
| 0.9.4 | 非执行 DAG 设计与同一 run 内复用已批准边界路径               |
| 0.9.3 | Artifact 文件清单、V4 RunState 与 V5 plan/checkpoint         |
| 0.9.2 | 顶层静态 DAG 中可恢复的直接 ToolAgent node                   |
| 0.9.1 | ToolAgent prompt 中确定且有预算的 Skill 路由索引             |
| 0.9.0 | 带 condition node、branch edge 与输入校验的 canonical DAG v1 |
| 0.8.3 | V3 Conversation/Run state 与 V4 plan/checkpoint              |
| 0.8.0 | TypeScript 首个完整 0.8 基线                                 |

详细变更见 [CHANGELOG](../../CHANGELOG.md)。

## 0.9.5

向 `runner.designDag()` 传入 `onEvent` 时会消费 Provider 真实流，并报告 response 与
validation 生命周期事件；不传 listener 时保留 0.9.4 的非流式 `chat` transport。
内置 `dag_design` profile 只用于设计，绝不会作为可执行 capability 暴露。返回 conversation
保存自然 summary、answer 或确定性失败说明，而不是 Provider 的结构化 JSON。

TypeScript workspace 同时新增 DagentWork 本地桌面端。它拥有独立 SQLite 与托管独立任务
工作区，只暴露 ToolAgent 执行、本地资源、审核、文件与观察到的变化，并明确移除全部 DAG
与企业版界面。详见 [DagentWork 桌面端](desktop.md)。

桌面 Launcher 的公开 npm 包名与可执行命令统一为 `dagent-work`。此前未发布的
`dagent-ai-desktop`/`dagent-desktop` 名称不保留兼容别名。

## 0.9.4

`runner.designDag()` 返回 proposal/no-change/answer/failure 判别联合，`runner.inspectDag()`
返回确定性 diagnostics。设计调用可以访问 Provider，但绝不调用 capability，也不创建 run、
review、checkpoint、result、artifact 或工作区写入。App 新增 `/api/v1/dags/design` 与
`/api/v1/dags/inspect`，Web DAG Studio 使用这两个明确的纯设计接口。详见
[非执行 DAG 设计](dag-design.md)。

可审核的 allowed-path 越界现在通过 `PendingReview.metadata` 报告规范化路径。批准只授权这些
路径供同一可恢复 run 的后续 ToolAgent 调用复用；不同路径仍需审核，授权不会成为跨 run、
project 或 user 策略，硬性工作区逃逸仍会阻止。这是 Python `boundary_paths` 在 TypeScript
既有 contract 中的有意表达：扩展现有 metadata，而不是新建平行 review payload。

## 0.9.3

静态 DAG 输入上传现在持久化排序后的 `ArtifactFileManifest`。`artifact.files` expression
暴露上传时的 `ArtifactFileRef`：相对工作区的 `path`、basename `name`、字节 `size` 和可选
`mediaType`。它不是工作区扫描。物化会拒绝 traversal、重复目标、符号链接目标、超过 256
个文件、单文件超过 25 MiB 或总量超过 100 MiB。

新 run 使用 V4 `RunState` 与 V5 `ResolvedRunPlan`/`RunCheckpoint`。包含 V3 state 的旧 V4
checkpoint 仍可读取，并明确具有空清单；resume 不会扫描文件来重建。成功继续后应持久化
新产生的 V5 checkpoint。

## 0.9.2

顶层静态 DAG 的直接 agent node 可以指向已注册 ToolAgent，并暂停/恢复其内部工具审核。
Checkpoint 会对直接 Agent 配置和挂起 invocation 做 fingerprint。普通静态 capability node
仍由图作者直接授权。Subgraph、map 或 loop 内的 Agent node 会在执行前被拒绝，因为嵌套进度
尚不能安全恢复。

## 0.9.1

ToolAgent prompt 为其最终解析的 Skill scope 加入确定、排序后的索引。完整名称/description
条目使用 8,000 字符预算，仅名称 fallback 另有 2,000 字符预算；省略项会引导模型调用
`skill.list`。完整 `SKILL.md` 仍通过 `skill.view` 按需加载；dynamic DAG planner prompt
保持不变。

## 0.9.0

### Condition 路由

`DagNode` 新增带有序 `cases` 和必填 `defaultBranch` 的 `kind: "condition"` 变体。
`DagEdge.branch` 把选中的 branch 连接到一个或多个下游节点；`DagNodeResult.selectedBranch`
持久化该决策。Host 和穷举 decoder 在加载 0.9 DAG/checkpoint 前必须接受这些新增/可选变体。

Builder 使用 `DagBuilder.condition(...)` 与 `addEdge(..., { branch })`；`allOf`、`anyOf`
和 `notCondition` 负责组合条件。普通 `condition` edge 继续作为独立 gate：branch edge
必须来自 condition node，同一条 edge 不能同时声明两种形式。

### 静态输入与输出

静态 `graphInput` 现在接受任意 `JsonValue`。声明的输入 schema 必须是有效且
self-contained 的 JSON Schema Draft 2020-12 文档。Runner 会在创建 workspace 前校验根
输入，并在调用子 capability 前校验 resolved subgraph/loop input。
`DagInputValidationError` 暴露实例 `path` 与 `schemaPath`。

精确的静态结构化输出继续通过 `RunOutcome.output`、V3 run state 和 V4 checkpoint
提供；saved-DAG 数据库不需要迁移。

### Runner 默认值与 Profile

`workspace` 与 `runtimeDirectory` 现在可选，默认值分别为 `~/.dagent` 和 `.runtime`。
负责持久化的 Host 应继续显式传值。内置 `conversation` profile 现在只负责直接回答和
有界 tool selection；DAG planning 仍由 DagAgent 负责。

### 兼容性

现有 capability、agent、subgraph、map、loop 和普通条件边 graph 行为保持不变。
Canonical schema version 仍为 1，conversation/checkpoint 仍为 V3/V4。破坏面仅限于不接受
0.9 新变体的穷举 node/edge/result decoder。

## 0.8.3

### Runner 参数

`workspace` 和 `runtimeDirectory` 现在是必填：

```ts
const runner = new Runner({
  provider,
  workspace: './workspace',
  runtimeDirectory: '.runtime',
});
```

使用 `createRunnerFromConfigFile()` 时也必须通过第二参数传入。删除
`ResultStoragePolicy.internalDirectory`；外置策略只配置 `maxInlineBytes`。

### 存储布局

私有目录统一放在 Host 选择的 runtime directory：

```text
<runner workspace>/<runtimeDirectory>/conversations
<run workspace>/<runtimeDirectory>/results
<run workspace>/<runtimeDirectory>/history
```

从旧布局迁移时应停止写入、复制资源并验证 checksum。目录现在按需创建，不能用“目录不
存在”判断功能未配置。

### `extraSystemPrompt`

Runner 新增有界、经过 schema 校验的 `extraSystemPrompt`。它作用于 ToolAgent、动态 DAG
planning/re-planning、AutoAgent 选中路径和注册 Agent，不作用于 router/validator。

每次运行将初始值冻结进 V4 plan；resume 不采用 Runner 当前值。公共 API 不返回该文本。

### Checkpoint V4

0.8.3 拒绝 V3 checkpoint。Host 应完成或导出旧等待审核 run，再升级；不要手写
fingerprint 或删除新字段。V4 仍使用 V3 conversation/run state，这是预期的独立版本。

### 会话 revision

审核后的 dynamic DAG 若执行失败、re-plan 并再次等待审核，conversation revision 现在会
推进。Host CAS 逻辑必须接受该 checkpoint 中的新 revision，不能假设一次 run 只更新会话
一次。

### 引用投影

内容、value 和 artifact references 在模型投影中有界且去重。依赖旧版重复注入行为的
prompt 应改为显式引用一次。

## 从 Python Dagent 0.9.5 迁移

### 包与语言边界

| Python 概念                       | TypeScript 入口                                                |
| --------------------------------- | -------------------------------------------------------------- |
| Runner                            | `new Runner(options)`                                          |
| function tool                     | `tool({ input: zod, output: zod, execute })`                   |
| Agent config                      | `defineToolAgent()` / `defineDagAgent()` / `defineAutoAgent()` |
| static DAG builder                | `DagBuilder<TInput, TOutput>`                                  |
| `ConditionNode`                   | `builder.condition(...)` 与 `{ branch }` edge options          |
| `all_of` / `any_of` / `not_`      | `allOf` / `anyOf` / `notCondition`                             |
| async event stream                | `for await (const event of runner.stream(...))`                |
| `design_dag` / `inspect_dag_spec` | `runner.designDag()` / `runner.inspectDag()`                   |
| Pydantic boundary                 | Zod schema                                                     |
| context manager                   | `await using` / `try...finally`                                |

不要把 Python class hierarchy 照搬成 TypeScript class。Agent 和领域契约应保持不可变数据，
可变生命周期集中在 Runner、Manager、Store 和 Host service。

### 配置

Python YAML 字段不保证与 TS App YAML 一致。以
[`examples/dagent.yaml`](../../examples/dagent.yaml) 为起点，重新填写 Provider、MCP、
Skills、Profiles、Sandbox 和模块。Python module path 不能加载到 TS Host，必须重写为
发布 ESM 的 capability module 或 MCP server。

### 数据

Python SQLite 和 TS SQLite schema 不承诺直接兼容。推荐：

1. 导出项目文件、Skill、Profile、Agent 配置和 canonical DAG。
2. 对仍需继续的会话导出完整 V3 ConversationState，并校验 identity。
3. 在隔离目录启动 TS Host。
4. 通过 API/脚本导入公开资源，重新建立 Provider/MCP 凭证。
5. 旧 awaiting-review checkpoint 不跨语言恢复，完成或关闭后再切换。

## 升级检查

```bash
pnpm install --frozen-lockfile
pnpm verify
node packages/app/dist/cli.js --version
```

升级 Host 前备份整个 `dataDirectory`，在副本上启动一次完成 migration，并验证 health、
会话详情、run event log、Skill、Provider 和 saved DAG。

## 降级

数据库 migration 和 checkpoint schema 不提供通用自动降级。需要回退时，恢复升级前的
完整数据目录备份和对应二进制；不要用旧程序打开已经迁移的活动数据库。
