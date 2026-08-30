# API Host 持久化

`dagent-ai-app` 是面向本地单用户工作流的统一 Host。它将项目、会话、运行、DAG 与配置
存入 SQLite，将项目文件和 runtime 私有数据保存在 `dataDirectory` 下。

## 本地项目模式

Host 启动时创建：

```text
<dataDirectory>/
├── dagent.sqlite3
├── workspace/
├── skills/
├── profiles/
├── capability-modules/
└── ...
```

数据库文件权限设置为 `0600`，SQLite 启用 WAL、foreign keys 和 5 秒 busy timeout。
`dataDirectory` 应位于本地受信磁盘；不建议将活动 SQLite 文件直接放在网络同步盘。

## 单写者租约

每个 Host 进程启动时获取 `app-writer` lease，默认 TTL 15 秒并定时续约。同一数据库已有
有效 lease 时，第二个进程拒绝启动。

这是本地进程协调，不是分布式 leader election。需要水平扩展时，应替换数据库与 lease
实现，而不是让多个进程共享 SQLite。

## 存储模型

主要表：

| 表                       | 内容                                                 |
| ------------------------ | ---------------------------------------------------- |
| `projects`               | 项目元数据与 root path                               |
| `conversations`          | V3 state、可空 project、workspace scope 与 revision  |
| `runs`                   | target、去敏 input、status、最新 V5 checkpoint       |
| `run_events`             | `(run_id, sequence)` 唯一的完整事件日志              |
| `saved_dags`             | canonical graph、画布 layout、revision、archive 状态 |
| `orchestration_sessions` | conversation、draft graph 与 UI state 的关联         |
| `agents`                 | 受管 Agent presets                                   |
| `model_providers`        | Provider 配置与 active 标记                          |
| `mcp_servers`            | 持久化 MCP server 配置                               |
| `capability_modules`     | 模块来源、路径、导出和启用状态                       |
| `template_capabilities`  | UI 创建的能力模板                                    |
| `settings`               | Validation 与应用设置                                |
| `leases`                 | 单写者租约                                           |

二进制上传不会原样塞进 `runs.input_json`；只保存文件名和 byte length。内容由 SDK
conversation resource store 或项目/artifact 文件系统管理。

## 会话持久化

只保存 identity 匹配的 V3 `ConversationState`：

- JSON `schemaVersion === 3`
- JSON `id` 与数据库 conversation id 相同
- JSON `revision` 与数据库 revision 对齐

整体更新使用 revision CAS。数据库中的旧 V1/V2 或损坏结构在迁移 009 中标为 schema
version 0；读取完整会话或继续运行返回冲突，不在请求路径中猜测转换。

`workspaceScope` 为 `project` 或 `standalone`。项目会话必须有 `projectId`，独立会话禁止该
字段。独立 run 使用 `<dataDirectory>/projects/_standalone/<conversationId>/workspace`，项目
run 继续使用所选 project root。Migration 011 会重建 conversation foreign-key 边界，并
保留已有项目会话。

## 运行与事件

新运行的事件流程是：

```text
Runner event
  → INSERT run_events
  → persist checkpoint/conversation when present
  → publish to in-process SSE listeners
```

唯一约束阻止同一 run sequence 重复写入。`event-log?after=N` 和 SSE
`Last-Event-ID: N` 都从数据库读取后续事件。

等待审核时，run 保存完整服务端 checkpoint。公共 API 返回裁剪投影；恢复必须使用数据库
中的原对象，而不是客户端传回的 checkpoint。

## 重启恢复

Host 启动时运行 `RunRecoveryService`：

- 上次进程遗留的活动状态会转换为可解释的中断/失败状态。
- 已持久化的 `awaiting-review` checkpoint 保留，可在新进程中恢复。
- SSE 客户端可以从已有 sequence 继续读取。
- 活动 Provider 请求和进程内取消控制器无法跨重启恢复。

Dagent 保证持久化边界上的恢复，不假装恢复已经丢失的网络 stream 或任意 JavaScript
stack。

## Saved DAG 与 orchestration

Saved DAG 同时保存 canonical graph 和独立 layout。graph 参与执行与校验；layout 只属于
UI。更新使用 revision 防止两个编辑器互相覆盖。

Orchestration session 将一次 DAG 编辑/运行工作流与 conversation、project 和可选 saved
DAG 关联。run 可以记录 savedDagId 和 orchestrationSessionId，便于查询历史，但 Runner
本身不依赖这些 Host id。

## 备份

安全备份建议：

1. 停止 Host，确保 writer lease 释放。
2. 复制整个 `dataDirectory`，包括 SQLite、WAL（若仍存在）和文件目录。
3. 在隔离路径启动副本，确认 migration 与 `/api/v1/health`。

仅复制 `dagent.sqlite3` 可能丢失 WAL 或外部资源。恢复到旧二进制前，应先阅读
[迁移说明](migration.md)；数据库 migration 不保证可逆降级。

## 企业化路径

若要改造成多用户服务，需要额外实现：

- 认证、授权和 tenant 隔离
- 密钥管理与审计日志
- PostgreSQL 等共享数据库及分布式 lease
- 对象存储和带租约的 artifact 生命周期
- worker queue、幂等 job 与运行所有权
- API rate limit、CSRF/CORS 与网络边界

这些不属于当前本地 Host 的安全承诺。
