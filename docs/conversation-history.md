# 会话历史与上下文

这部分采用多轮历史改造方案，不把“聊天记录”简化为 provider 消息数组。

## 三个独立视图

1. `conversation`：用户可见的稳定历史，只包含用户消息和最终助手消息。
2. `modelThread`：一次 Agent 连续推理所需的内部线程，包含工具调用结果、规划消息和
   内部助手消息。
3. `contextUsage`：每次模型调用前的预算、截断和压缩审计记录。

每条记录都是判别联合：

- `UserMessage`
- `AssistantMessage`
- `ToolResultMessage`

消息还带 `scope`（conversation、router、planner、validator、subagent、compactor）
和 `visibility`（user、internal）。provider 适配发生在最后一步，因此 OpenAI 兼容
字段不会污染持久化模型。

## 推理记录

`AssistantMessage.reasoning` 可存储 provider 返回的 reasoning 字段或 think 标签内容。
它可在 Run Inspector 中审计，但 ContextAssembler 从不把它投影回模型请求，避免隐藏
推理被递归放大或意外暴露。

## 上下文压缩

默认策略：

- 输入占上下文窗口 80% 时触发；
- 保留最近 4 个 turn；
- 摘要预算 1024 token；
- 单个工具结果最多 2048 token；
- 工具结果合计最多 8192 token；
- 预留 15% 安全余量。

优先用模型生成保留需求、约束、事实、失败和未完成事项的摘要。如果压缩模型失败，
使用确定性 fallback，并在 `ContextUsage.compactionMethod` 中记录。大型工具结果原子
写入运行目录，只在历史中保留相对路径、字节数、SHA-256 和 preview。

## 检查点

审核检查点同时保存 `conversation`、`modelThread` 和 `contextUsage`。恢复时继续原模型
线程，但下一条最终回答只追加到公开 conversation。这样既保持多轮连贯性，也不会把
工具噪声直接展示给用户。
