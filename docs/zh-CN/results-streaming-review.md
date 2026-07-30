# 会话、结果、流式事件与审核

## 延续多轮会话

```ts
const first = await runner.run(agent, { prompt: 'Inspect the project.' });

const second = await runner.run(agent, {
  prompt: 'Now summarize the risky changes.',
  conversation: first.state.conversation,
});
```

每次新运行拥有新的 `runId`，但可以继续同一份 `ConversationState` identity 和 revision。
Host 通过 conversation id 自动加载完整 V3 文档，并用 revision compare-and-swap 保存。

## 实际输入模型的内容

Conversation 中的每个 item 都有 scope 和 visibility。`ContextAssembler` 根据本次调用角色
生成 Provider messages：

- 用户与助手可见文本按顺序进入上下文。
- tool result 按单项与总预算截断。
- reasoning 永不回放。
- router、planner、validator、subagent 和 compactor 只得到各自需要的投影。
- 内容、值和 artifact 引用去重并受总预算限制。

公共 HTTP 会话是另一种只读投影：只保留 `visibility=user` 内容，并移除助手 reasoning、
tool calls 和内部压缩细节。它不是可以传回 SDK 的完整 ConversationState。

## 上下文限制与压缩

默认策略：

| 字段                       | 默认值 |
| -------------------------- | -----: |
| `compactionTriggerRatio`   |  `0.8` |
| `keepRecentTurns`          |    `4` |
| `summaryMaxTokens`         | `1024` |
| `maxToolResultTokens`      | `2048` |
| `maxTotalToolResultTokens` | `8192` |
| `tokenSafetyMargin`        | `0.15` |

达到阈值后，Runner 保留最近 turn，对早期内容生成有界摘要。模型压缩失败时使用确定性
fallback，并在 `ContextUsage.compactionMethod` 记录方法。

如果系统提示、tool schemas 和必要上下文本身已超过预算，Runner 抛出
`ContextWindowExceededError`，不会静默丢弃安全提示或伪造 token 容量。

## Provider usage 与 reasoning

`token` 事件的 `channel` 为 `content` 或 `reasoning`。reasoning 可以留在内部
`AssistantMessage` 供审计，但不会由公共会话 API 返回，也不会进入下一轮模型上下文。

Provider 返回的 usage 写入运行审计。并非所有 OpenAI-compatible 端点支持流式 usage；
只有确认端点兼容时才设置 `streamIncludeUsage: true`。

## 大型结果

`resultStorage.maxInlineBytes` 默认 256 KiB。超过阈值的 JSON 结果写入：

```text
<run workspace>/<runtimeDirectory>/results/
```

历史中的 `ContentReference` 保存相对路径、MIME、字节数、SHA-256 和 preview。下游节点、
map、loop 以及 resume 只有在 provenance 明确时才恢复值。文件缺失、checksum 变化或引用
逃逸 runtime directory 都会失败。

这些私有目录按需创建。没有附件、大结果或恢复历史的运行不会留下空目录树。

## 流式事件

```ts
for await (const event of runner.stream(target, input, { signal })) {
  switch (event.type) {
    case 'run-started':
    case 'token':
    case 'plan-proposed':
    case 'review-required':
    case 'node-started':
    case 'node-completed':
    case 'capability-started':
    case 'capability-completed':
    case 'checkpoint':
    case 'context-compaction-started':
    case 'context-compaction-finished':
    case 'context-usage':
    case 'validation-started':
    case 'validation-finished':
    case 'run-completed':
      break;
  }
}
```

`RunEvent` 是完整判别联合，每个事件都有 runId、从 1 开始的 sequence 和带时区 timestamp。
SDK stream 在完成时自然结束，错误时 iteration 抛出。

Host 将事件先写入 SQLite，再广播 SSE。客户端使用 SSE `id` 或 `Last-Event-ID` 恢复时，只
收到更大 sequence；不依赖进程内缓冲。

## 审核与恢复

```ts
const outcome = await runner.run(target, input);

if (outcome.status === 'awaiting-review') {
  const resumed = await runner.resume(outcome.checkpoint, {
    reviewId: outcome.review.id,
    revision: outcome.review.revision,
    action: 'approve',
    reason: 'Reviewed by operator.',
  });
}
```

拒绝：

```ts
await runner.resume(checkpoint, {
  reviewId: review.id,
  revision: review.revision,
  action: 'reject',
  reason: 'The requested path is outside policy.',
});
```

DAG review 还可附带经过校验的 `replacementGraph`。

恢复前 Runner 会验证：

- checkpoint schema version 与 fingerprint
- review id 和 revision
- capability 定义 fingerprint 与 scope
- 冻结执行限制和已消耗 usage
- runtime directory、工作区 continuation resources 与 conversation revision
- 同一个 review 是否已消费

在 SDK 进程内，重复决定会被拒绝；Host 额外使用数据库原子 claim，防止并发请求和重启后
重复消费。审核后的 dynamic DAG 若失败并再次规划到审核边界，会推进权威 conversation
revision。

## 取消

传 `AbortSignal`：

```ts
const controller = new AbortController();
const promise = runner.run(target, input, { signal: controller.signal });
controller.abort();
```

或使用事件中的 runId：

```ts
runner.cancel(runId, 'Cancelled by user.');
```

能力实现和 Provider adapter 应响应 signal。取消是正常的 `RunOutcome` 状态，不应由 Host
改写为通用 500。
