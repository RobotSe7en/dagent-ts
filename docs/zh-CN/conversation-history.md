# 会话历史与上下文

0.8 系列采用 V3 会话方案，不把“聊天记录”简化为 Provider messages，也不维护两份
会话状态。

## 一个权威文档、两个投影视图

V3 只持久化一个完整、有界的 `ConversationState`。它同时包含用户消息、助手回答、
工具调用结果，以及 planner、validator 等内部审计项。`scope` 和 `visibility` 决定用途：

- ContextAssembler 从该文档生成 provider 输入，但永不回放 reasoning；
- HTTP 层返回独立的 `PublicConversationState` 投影：只保留 `visibility=user` 的项，
  移除助手 reasoning、tool calls 和压缩器 reasoning；
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
Web 可展示压缩后的早期上下文内容，但它消费的是上述公共摘要类型，而不是内部
`ContextSummary`。

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

V5 审核检查点保存完整 V3 `conversation`、冻结的能力定义指纹、执行限制、运行目录、
初始附加系统提示和 `contextUsage`。Host 对 checkpoint 使用一次性原子 claim，并在整体
替换会话时使用 revision compare-and-swap。重复审核、定义变化或过期会话 revision
都会在执行前被拒绝。

数据库迁移不会在运行时猜测 V1/V2 结构：没有合法且 identity 匹配的 V3 文档会被标记为
`legacy`，详情与继续运行接口返回 HTTP 409。

## Revision 与并发

`ConversationState.revision` 每次权威修改都单调增加。Host 使用 revision
compare-and-swap 保存整体文档；更新行数不是 1 就表示并发冲突，运行失败而不是覆盖另一
条请求的历史。

同一会话一次只能拥有一个活动或等待审核的 run；新请求返回
`CONCURRENCY_CONFLICT`。review 恢复后若 dynamic DAG 执行失败并 re-plan，再次进入审核
也会推进 revision。这样第二个 checkpoint 不会伪装成与第一次审核相同的会话状态。

## 附件和引用生命周期

上传首先进入 content-addressed conversation store：

```text
<runner workspace>/<runtimeDirectory>/conversations/
```

模型上下文只得到有界的附件描述与内容引用。执行到不同 `workspacePath` 时，运行时会根据
checksum 重建需要的资源。后续轮次只恢复具有明确 provenance 的引用；同形状的普通用户
JSON 不会被当作文件或外置结果。

run 的大值位于：

```text
<run workspace>/<runtimeDirectory>/results/
```

resume 需要的历史位于：

```text
<run workspace>/<runtimeDirectory>/history/
```

V5 checkpoint 冻结 `runtimeDirectory`，因此 Runner 配置修改不会让旧 run 去错误目录寻找
资源。

## Host 公共投影

公共 run 与 conversation 响应还会删除：

- target 的 `systemPrompt`
- plan 的 `extraSystemPrompt`
- validator profile 正文
- reasoning token 事件

这些值仍可以在服务端权威 checkpoint 中用于恢复，只是不属于浏览器 API。公共 trace 从
持久化事件和 checkpoint 计算，不是额外的可写状态。

## 集成约束

- SDK Host 必须持久化完整、原样的 V3 `ConversationState`。
- 不要把公共 conversation 投影回写成权威历史。
- 不要手工拼接 item id、run id 或 revision。
- checkpoint 和 conversation 的保存必须位于可检测并发的事务边界。
- reasoning 的保留策略可以更严格，但不能把 reasoning 当作下一轮模型输入。

相关文档：[会话、结果、流式与审核](results-streaming-review.md)、
[0.8 Host 迁移](host-migration-0.8.md)。
