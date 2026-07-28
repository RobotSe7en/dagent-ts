# HTTP API

所有接口位于 `/api/v1`。错误统一返回：

```json
{
  "error": {
    "code": "INVALID_INPUT",
    "message": "..."
  }
}
```

## 主要资源

| 方法            | 路径                                 | 用途                   |
| --------------- | ------------------------------------ | ---------------------- |
| GET/POST        | `/projects`                          | 列出或创建项目         |
| GET/DELETE      | `/projects/:id`                      | 读取或删除项目         |
| GET             | `/projects/:id/files?path=`          | 安全浏览项目文件       |
| GET             | `/projects/:id/conversations`        | 项目会话               |
| POST            | `/conversations`                     | 创建会话               |
| GET/DELETE      | `/conversations/:id`                 | 会话详情或删除         |
| POST            | `/runs`                              | 启动 Agent 或静态 DAG  |
| GET             | `/runs/:id`                          | 运行及最新检查点       |
| GET             | `/runs/:id/events`                   | 可恢复 SSE             |
| POST            | `/runs/:id/cancel`                   | 取消活动运行           |
| POST            | `/runs/:id/reviews`                  | 提交审核决策           |
| GET/PUT         | `/capabilities`、`/capabilities/:id` | 当前能力目录与启停     |
| POST            | `/dags/validate`                     | 校验 canonical DAGSpec |
| GET/POST/DELETE | `/skills`                            | Skills 管理            |
| GET             | `/skills/view`                       | 读取 Skill 或链接文件  |
| GET/POST/DELETE | `/mcp`、`/mcp/:name`                 | MCP 状态、连接与卸载   |
| GET/PUT         | `/settings`、`/settings/:key`        | JSON 设置              |

## 启动运行

```json
{
  "conversationId": "conversation_...",
  "target": {
    "kind": "tool-agent",
    "id": "assistant",
    "name": "Assistant",
    "scope": { "capabilities": ["tool.read_file"] }
  },
  "input": {
    "prompt": "Read the attached specification",
    "uploads": [
      {
        "filename": "spec.md",
        "contentBase64": "IyBTcGVjaWZpY2F0aW9u"
      }
    ]
  }
}
```

服务返回 `202` 和 `runId`。客户端随后连接事件流。

Host 只接受 V3 conversation id；旧 conversation 会明确返回
`409 LEGACY_CONVERSATION`。会话更新采用 revision CAS，同一 review checkpoint 也只能
原子消费一次。

## SSE 恢复

事件使用 `sequence` 作为 SSE `id`，并用 `type` 作为 event 名。浏览器自动重连时会发送
`Last-Event-ID`；服务只返回更大的序号。事件先写入 SQLite，成功后才广播，因此重连
不会依赖进程内缓存。

审核恢复产生的新运行时事件会重新映射到同一 run 的后续持久化序号，避免与审核前事件
冲突。
