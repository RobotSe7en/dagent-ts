# 会话历史与上下文

这部分采用 0.8.0 V3 会话方案，不把“聊天记录”简化为 provider 消息数组，也不维护两份
会话状态。

## 一个权威文档、两个投影视图

V3 只持久化一个完整、有界的 `ConversationState`。它同时包含用户消息、助手回答、
工具调用结果，以及 planner、validator 等内部审计项。`scope` 和 `visibility` 决定用途：

- ContextAssembler 从该文档生成 provider 输入，但永不回放 reasoning；
- HTTP 层只返回 `visibility=user` 的项，并移除助手 reasoning 与 tool calls；
- `ContextUsage` 作为 run checkpoint/事件审计保存，不再拆成第二份会话历史。

会话项是判别联合：

- `UserMessage`
- `AssistantMessage`
- `ToolResultMessage`

provider 适配发生在最后一步，因此 OpenAI 兼容字段不会污染持久化模型。

## 推理记录

`AssistantMessage.reasoning` 可存储 provider 返回的 reasoning 字段或 think 标签内容。
它属于内部审计数据。ContextAssembler 不会把它投影回模型请求，公共 HTTP 投影也不会
返回它，避免隐藏推理被递归放大或意外暴露。

## 上下文压缩

默认策略：

- 输入占上下文窗口 80% 时触发；
- 保留最近 4 个 turn；
- 摘要预算 1024 token；
- 单个工具结果最多 2048 token；
- 工具结果合计最多 8192 token；
- 预留 15% 安全余量。

优先用模型生成保留需求、约束、事实、失败和未完成事项的摘要。如果压缩模型失败，
使用确定性 fallback，并在 `ContextUsage.compactionMethod` 中记录。压缩输入和输出都
严格受 token budget 限制。

大型工具结果原子写入运行目录，只在历史中保留有类型的相对路径、字节数、SHA-256 和
preview。只有带 `valueReference` provenance 的值才会被恢复，普通用户 JSON 不会被
误识别为引用。附件和会话引用会进入 content-addressed store，并在下一轮工作区重建。

## 检查点与 Host 持久化

审核检查点保存完整 V3 `conversation`、冻结的能力定义指纹、执行限制和
`contextUsage`。Host 对 checkpoint 使用一次性原子 claim，并在整体替换会话时使用
revision compare-and-swap。重复审核、定义变化或过期会话 revision 都会在执行前被拒绝。

数据库迁移不会在运行时猜测 V1/V2 结构：没有合法且 identity 匹配的 V3 文档会被标记为
`legacy`，详情与继续运行接口返回 HTTP 409。
