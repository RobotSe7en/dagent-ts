# HTTP API

统一 Host 的所有应用接口位于 `/api/v1`。默认只监听 `127.0.0.1`，不提供内建多用户认证。

## 协议约定

- 请求和普通响应使用 `application/json`。
- 创建资源通常返回 `201`，异步启动/恢复返回 `202`，成功删除返回 `204`。
- 所有时间为带 offset 的 ISO 8601 字符串。
- 资源 id 是不透明字符串，不应从前缀推断业务逻辑。
- 未知字段会在主要写接口被 Zod strict schema 拒绝。

错误：

```json
{
  "error": {
    "code": "INVALID_INPUT",
    "message": "...",
    "issues": []
  }
}
```

`issues` 只在 schema 校验错误时出现。常见状态：

- `400`：输入、DAG、能力或 checkpoint 契约无效
- `404`：资源或 capability 不存在
- `409`：并发 revision、旧会话、活动 run 或 stale review
- `500`：未分类的 Host 错误

## Health

```http
GET /api/v1/health
```

```json
{ "status": "ok", "version": "0.9.5" }
```

## 项目与文件

| 方法                                | 路径                           | 用途                              |
| ----------------------------------- | ------------------------------ | --------------------------------- |
| `GET` / `POST`                      | `/projects`                    | 列出、创建项目                    |
| `GET` / `PATCH` / `DELETE`          | `/projects/:id`                | 读取、更新、删除项目              |
| `GET` / `POST` / `PATCH` / `DELETE` | `/projects/:id/files`          | 浏览、上传、移动/重命名、删除文件 |
| `POST`                              | `/projects/:id/directories`    | 创建目录                          |
| `GET`                               | `/projects/:id/files/download` | 下载文件                          |

所有路径都相对项目 root，并进行边界与符号链接校验。

## 会话

| 方法                       | 路径                                                 | 用途               |
| -------------------------- | ---------------------------------------------------- | ------------------ |
| `GET` / `POST`             | `/conversations`                                     | 全局查询或创建     |
| `GET` / `PATCH` / `DELETE` | `/conversations/:id`                                 | 详情、改标题、删除 |
| `GET`                      | `/conversations/:id/messages`                        | 用户可见消息投影   |
| `GET`                      | `/conversations/:id/runs`                            | 会话运行           |
| `GET` / `POST`             | `/projects/:id/conversations`                        | 项目范围会话       |
| `GET` / `PATCH` / `DELETE` | `/projects/:projectId/conversations/:conversationId` | 项目范围详情       |

创建：

```json
{
  "projectId": "project_...",
  "workspaceScope": "project",
  "title": "Release review",
  "kind": "chat"
}
```

`kind` 为 `chat`、`dynamic-dag` 或 `static-dag`。详情中的 conversation 是公共 V3 投影：
reasoning、tool calls、内部项和敏感 system prompts 已删除。
托管独立会话省略 `projectId` 并使用 `workspaceScope: "standalone"`；运行会获得隔离的
Host 托管工作区，而不是项目 root。

## 启动运行

```http
POST /api/v1/runs
```

Agent：

```json
{
  "conversationId": "conversation_...",
  "target": {
    "kind": "tool-agent",
    "id": "assistant",
    "name": "Assistant",
    "scope": {
      "capabilities": ["tool.read_file"],
      "skills": [],
      "agents": []
    },
    "reviewLevel": "risky"
  },
  "input": {
    "prompt": "Read the attached specification.",
    "uploads": [
      {
        "filename": "spec.md",
        "contentBase64": "IyBTcGVjaWZpY2F0aW9u"
      }
    ]
  }
}
```

静态 DAG：

```json
{
  "target": {
    "kind": "static-dag",
    "graph": {
      "schemaVersion": 1,
      "id": "example",
      "name": "Example",
      "nodes": [],
      "edges": [],
      "artifacts": {}
    },
    "reviewLevel": "never"
  },
  "input": {
    "graphInput": {},
    "artifactUploads": {}
  }
}
```

`graphInput` 可以是任意 JSON value，并会按 graph 可选的 Draft 2020-12 `inputSchema`
校验。Canonical 0.9 graph 可以包含 `kind: "condition"` 节点、`branch` edge，以及完成
节点结果中的 `selectedBranch`。

上传最多 32 个 Agent attachments，内容必须是合法 base64。返回：

```json
{ "runId": "run_..." }
```

状态码为 `202`。调用者随后读取 run、event log 或 SSE。

## 运行资源

| 方法             | 路径                           | 用途                                                 |
| ---------------- | ------------------------------ | ---------------------------------------------------- |
| `GET`            | `/runs`                        | 按 project/conversation/saved DAG/orchestration 过滤 |
| `GET` / `DELETE` | `/runs/:id`                    | 详情或删除已结束运行                                 |
| `POST`           | `/runs/:id/cancel`             | 请求取消活动运行                                     |
| `POST`           | `/runs/:id/reviews`            | 恢复等待审核的运行                                   |
| `GET`            | `/runs/:id/event-log?after=N`  | JSON 事件日志                                        |
| `GET`            | `/runs/:id/trace`              | 公共 trace、usage 和事件                             |
| `GET`            | `/runs/:id/events`             | 可恢复 SSE                                           |
| `GET`            | `/runs/:id/artifacts`          | 运行产物列表                                         |
| `GET`            | `/runs/:id/artifacts/preview`  | 安全预览                                             |
| `GET`            | `/runs/:id/artifacts/download` | 下载产物                                             |

活动 run 不能删除。reasoning token 不出现在公共 event log、trace 或 SSE。

## SSE

```http
GET /api/v1/runs/run_123/events
Accept: text/event-stream
Last-Event-ID: 17
```

事件格式：

```text
id: 18
event: node-completed
data: {"runId":"run_123","sequence":18,...}
```

Host 每 15 秒发送注释 heartbeat。事件先持久化再广播；连接建立时先订阅实时流，再读取
数据库历史，并用 sequence 去重，因此不会在两者切换间漏事件。

## 审核

```http
POST /api/v1/runs/:id/reviews
```

```json
{
  "reviewId": "review_...",
  "revision": 0,
  "action": "approve",
  "reason": "Approved by operator."
}
```

Host 从数据库读取完整 checkpoint，并原子 claim review。客户端不上传 checkpoint。重复、
过期或不匹配的决定返回 `409`。

## DAG 与编排

| 方法                       | 路径                               | 用途                           |
| -------------------------- | ---------------------------------- | ------------------------------ |
| `POST`                     | `/dags/validate`                   | 校验 canonical DAGSpec         |
| `POST`                     | `/dags/inspect`                    | 返回确定性 DAG diagnostics     |
| `POST`                     | `/dags/design`                     | 非执行型模型辅助 DAG 设计      |
| `GET` / `POST`             | `/saved-dags`                      | 查询、创建保存图               |
| `GET` / `PATCH` / `DELETE` | `/saved-dags/:id`                  | 详情、revision 更新、归档/删除 |
| `GET` / `POST`             | `/saved-dags/:id/runs`             | 图的运行历史与启动             |
| `POST`                     | `/orchestration-sessions`          | 创建编排会话                   |
| `GET` / `PATCH`            | `/orchestration-sessions/:id`      | 详情和 revision 更新           |
| `GET`                      | `/orchestration-sessions/:id/runs` | 编排运行                       |

Saved DAG 的 graph 与 layout 分开存储；只有 graph 进入 Runner。
设计与检查不会启动 run 或调用图。详见 [非执行 DAG 设计](dag-design.md)。

## 配置资源

| 资源                 | 路径                                 | 操作                                 |
| -------------------- | ------------------------------------ | ------------------------------------ |
| Agent presets        | `/agents`、`/agents/:id`             | list/create/get/update/delete        |
| Providers            | `/models`、`/models/:id`             | CRUD，`/:id/activate`                |
| MCP                  | `/mcp/servers`、`/mcp/servers/:name` | CRUD，`/mcp/reload`                  |
| Capability catalog   | `/capabilities`、`/capabilities/:id` | 查询、启停、直接测试                 |
| Capability templates | `/capabilities/templates`            | CRUD                                 |
| TypeScript modules   | `/capability-modules`                | 发现、校验、上传、源码、reload、CRUD |
| Profiles             | `/profiles`、`/profiles/:name`       | managed profile CRUD                 |
| Skills               | `/skills`、`/skills/view`            | list/view/install/delete             |
| Validation           | `/settings/validation`               | get/update                           |
| Sandbox              | `/sandbox/status`                    | Docker 可用性和策略                  |

密钥、Agent system prompts、Host `extraSystemPrompt` 和 validator profile 正文不会随 run
公共投影返回。

## OnlyOffice

Host 包含可选本地文档集成路由：

- `/system/onlyoffice`
- `/projects/:id/files/onlyoffice/config`
- `/runs/:id/artifacts/onlyoffice/config`
- `/onlyoffice/files/:token`
- `/onlyoffice/callback/:token`

未配置时不影响普通文件和产物 API。token 用于临时文件访问，不替代将 Host 暴露到公网时
所需的整体认证。
