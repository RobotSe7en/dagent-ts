# 核心概念

## Runner

`Runner` 是 SDK 的生命周期与执行边界。它拥有：

- `ChatProvider`
- `CapabilityCatalog`
- 已注册 Agent
- MCP 连接和 SkillStore
- 上下文预算、执行限制和结果外置策略
- 活动运行、审核 checkpoint 与取消控制器

Runner 不拥有 HTTP、SQLite 或浏览器状态。应用可以直接嵌入 SDK，也可以使用
`dagent-ai-app` 作为持久化 Host。

## 声明式 Agent

Agent 是经 Zod 解析并冻结的数据对象，而不是需要继承的类：

- `ToolAgent`：模型在有界 loop 中选择 capability。
- `DagAgent`：模型先产生 canonical `DAGSpec`，执行失败时可局部 re-plan。
- `AutoAgent`：先路由到 ToolAgent 或 DagAgent，再执行所选目标。

共享字段包括 id、名称、描述、system prompt、能力作用域、审核等级和上下文策略。用
`defineToolAgent()`、`defineDagAgent()`、`defineAutoAgent()` 创建，可在构造 Runner 时
注册，也可直接作为 `run()` 的 target。

## Tool Loop 与 Dynamic DAG

ToolAgent 适合短、交互式、下一步取决于刚刚结果的任务。DagAgent 适合多步骤、可并行、
需要先展示计划或失败后局部重排的任务。

Dynamic planner 只生成结构化 DAG 数据。该数据经过 schema、图结构、能力 scope、
表达式依赖、artifact 和限制校验后才进入 `DagExecutor`。模型不会生成可直接执行的
TypeScript。

## 静态 DAG

静态 DAG 适合宿主已经知道流程的场景。`DagBuilder<TInput, TOutput>` 通过泛型
`ValueRef<T>` 连接节点，最终输出与动态 planner 相同的 `DAGSpec`。

节点类型：

- `capability`：调用能力目录中的绑定
- `agent`：调用已注册 Agent
- `subgraph`：执行嵌套图
- `map`：对有界列表并发执行子图
- `loop`：在最大迭代数内执行子图直到条件成立

静态图是纯数据，可以验证、持久化、由 Web 可视化，并在不同进程中重新执行。

## Capabilities

Capability 是所有外部动作的统一抽象。`CapabilityBinding<TInput, TOutput>` 由以下部分
组成：

- 稳定的 capability id
- kind、描述、风险、边界和来源元数据
- Zod 输入与输出 schema
- 类型化 `execute(input, context)`

TypeScript tool、内置文件/命令/内存能力、MCP tool 和 Skill accessor 都进入同一个
`CapabilityCatalog`。Agent scope 只引用 capability id，不持有执行函数。

## Skills

Skill 是包含 `SKILL.md` 的目录，用于给 Agent 提供可发现的工作说明和关联文件。Runner
把 SkillStore 暴露为受控 capability，因此模型只能先列出、再读取被允许的文件。

Skill 与 tool 的边界不同：Skill 主要传递方法和上下文；tool 执行结构化动作。一个成熟
能力通常可以同时提供 Skill 指导和 tool 实现。

## Conversation、Result 与 State

V3 `ConversationState` 是多轮历史的唯一权威文档。它保存用户、助手、tool result 和内部
审计项，并通过 scope/visibility 投影为：

- 发给 Provider 的有界模型上下文
- 发给公共 HTTP 客户端的用户可见会话

大结果按策略写入 `<run workspace>/<runtimeDirectory>/results`，历史中保存 checksum、
preview 和 provenance；后续节点需要时透明恢复。普通用户 JSON 不会被猜成内部引用。

`RunState` 描述当前执行，`RunOutcome` 描述调用结果，`RunEvent` 描述有序过程。审核暂停时
由 V5 `RunCheckpoint` 冻结 target、能力定义指纹、限制、工作区运行目录、初始附加系统
提示和会话状态。

## Host

`dagent-ai-app` 将 SDK 包装成一个本地应用：

```text
React Web ── REST/SSE ── Fastify ── services ── repositories ── SQLite
                                  └── Runner
```

Host 使用单写者租约、SQLite WAL、会话 revision CAS、review 原子 claim 与持久化事件序号
保证恢复行为。它不是 SDK 的必要组成部分，但为桌面式和本地 Web 工作流提供统一入口。
