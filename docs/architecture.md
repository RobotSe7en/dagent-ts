# 架构

## 分层

```text
React Web UI
    │ REST + resumable SSE
Fastify application
    │ repositories / run service
Kysely + SQLite
    │
dagent-ai Runner
    ├─ ToolAgentRuntime
    ├─ DynamicPlanner → canonical DAGSpec
    ├─ DagExecutor
    ├─ review checkpoints
    └─ context assembler / result storage
         │
CapabilityCatalog
    ├─ TypeScript capabilities
    ├─ MCP stdio / streamable HTTP
    ├─ Skills accessors
    └─ optional Docker command executor
```

`dagent-ai` 不依赖服务端或浏览器。`dagent-ai-app` 负责本地单用户进程、数据库、
HTTP 生命周期和静态 UI。Web 端只消费版本化 API，不接触运行时内部对象。

## 核心契约

- `CapabilityBinding<TInput, TOutput>` 将 Zod schema、执行函数和边界元数据绑定。
- `DAGSpec` 是唯一执行图格式。节点支持 capability、agent、subgraph、map 和
  bounded loop。
- `RunState` 是当前状态，`RunCheckpoint` 冻结目标、能力作用域、限制和状态。
- `RunEvent` 是带运行 ID、序号和时间戳的判别联合。
- `ConversationState` 是 provider-neutral 的历史记录。

所有跨边界数据在进入领域层时解析一次。内部逻辑依赖已解析类型，不在各层重复猜测
结构。

## 执行与恢复

静态 DAG 先进行完整结构校验：重复 ID、环、边、表达式依赖和 artifact 引用都会在
执行前失败。动态 DAG 使用结构化输出，同样经过校验和能力白名单检查。

节点失败时，动态 Agent 可在 `maxReplans` 限制内重新规划。只有已完成节点会被保护并
复用；失败节点允许替换或重跑。审核使用检查点 fingerprint，过期 revision 会被拒绝。

## 安全边界

- Workspace 同时进行路径规范化和 `realpath` 检查；写入拒绝最终符号链接。
- Shell 能力默认是高风险能力，并拦截明确的系统级破坏命令。
- Docker 后端使用只读根文件系统、无网络默认值、能力全丢弃、进程/CPU/内存限制。
- MCP 工具在接入时转成普通能力，仍然经过作用域和审核策略。
- TS 工具模块要求显式路径和导出名，并可限制在配置目录内。

## 持久化

SQLite 使用 WAL、外键和 busy timeout。服务启动时获取带心跳的单写者租约。
`run_events` 对 `(run_id, sequence)` 建立唯一约束；SSE 先读取历史事件，再订阅实时
事件。会话表只保存 identity 匹配的完整 V3 `ConversationState`；checkpoint 独立保存在
run 表。会话整体替换使用 revision CAS，review 恢复先对 checkpoint 做原子 claim。
公共消息、trace 和 context usage 都是权威文档或 run 事件的投影，不是第二份状态。
