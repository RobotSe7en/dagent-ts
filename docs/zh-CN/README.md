# Dagent TypeScript 中文文档

[English documentation](../en/README.md)

这里是 `dagent-ai` SDK、`dagent-ai-app` 本地 Host 和 React 工作台的文档入口。
文档以 TypeScript 公开契约和 0.8.3 实际行为为准，不把 Python API 机械替换成
TypeScript 拼写。

## 从这里开始

| 文档                                     | 适合什么时候读                                     |
| ---------------------------------------- | -------------------------------------------------- |
| [安装](installation.md)                  | 确认 Node.js、pnpm、Provider 与本地开发环境        |
| [快速开始](quick-start.md)               | 编写第一个 ToolAgent 和静态 DAG                    |
| [核心概念](concepts.md)                  | 理解 Runner、Agent、Capability、DAG、Skills 与审核 |
| [TypeScript SDK 参考](typescript-sdk.md) | 快速定位公开导出、子路径和常用签名                 |
| [示例](../../examples/README.zh-CN.md)   | 直接运行仓库中的 TypeScript 与 YAML                |

## 功能指南

| 主题                                           | 文档                                                  |
| ---------------------------------------------- | ----------------------------------------------------- |
| Runner、Provider、YAML、MCP、Profiles、Sandbox | [Runner 和配置](runner-and-configuration.md)          |
| ToolAgent、DagAgent、AutoAgent                 | [Agents](agents.md)                                   |
| 内置能力、自定义 TypeScript Tool、MCP、边界    | [Capabilities](capabilities.md)                       |
| `DagBuilder`、引用、map、subgraph、loop        | [静态 DAG](static-dag.md)                             |
| Skill roots、managed installs 与 Skill 能力    | [Skills](skills.md)                                   |
| 多轮会话、上下文、流式事件、大结果和审核       | [会话、结果、流式与审核](results-streaming-review.md) |
| V3 权威历史与公共投影                          | [会话历史与上下文](conversation-history.md)           |
| SDK、Host、数据库和 Web 分层                   | [架构](architecture.md)                               |

## Host 与运维

| 主题                               | 文档                                       |
| ---------------------------------- | ------------------------------------------ |
| SQLite、项目、运行恢复和单写者模型 | [Host 持久化](api-backend-persistence.md)  |
| REST、SSE、错误和资源路由          | [HTTP API](http-api.md)                    |
| 0.8 Host 数据与请求迁移            | [SDK 0.8 Host 迁移](host-migration-0.8.md) |
| 版本差异和升级动作                 | [迁移说明](migration.md)                   |
| 常见配置与运行错误                 | [故障排查](troubleshooting.md)             |

## 文档约定

- 示例默认使用 ESM、严格 TypeScript、Node.js 24 和 Zod 4。
- SDK 运行目录写成 `<workspace>/<runtimeDirectory>`；Host 数据目录写成
  `<dataDirectory>`，二者不要混淆。
- `DAGSpec`、`ConversationState`、`RunCheckpoint` 等名称指公开的版本化契约。
- 内部实现计划不属于产品文档；设计边界只记录已经实现且可验证的行为。

版本变化以 [CHANGELOG](../../CHANGELOG.md) 和 [迁移说明](migration.md) 为准。
