# SDK 0.8 Host 迁移

本页面向自行嵌入 `dagent-ai` 的 Host 作者。使用 `dagent-ai-app` 时，Kysely migration 会
自动处理数据库结构，但仍应备份完整数据目录。

## 持久化边界

0.8 Host 应持久化：

- 完整 V3 `ConversationState`
- 最新 V4 `RunCheckpoint`
- 原始、按 sequence 有序的 `RunEvent`
- run target 和去敏输入元数据
- project/workspace 与 runtime directory 的归属关系

不应单独维护：

- Provider messages
- model thread
- 可写的公共 conversation projection
- 与 checkpoint 分离的“当前 review”副本
- 从事件反推后再回写的第二份 context usage

## 请求映射

SDK Agent 请求：

```ts
{
  prompt: string;
  conversation?: ConversationState;
  uploads?: ArtifactUpload[];
}
```

静态 DAG 请求：

```ts
{
  graphInput?: JsonObject;
  artifactUploads?: Record<string, ArtifactUpload[]>;
}
```

HTTP 层可用 base64、multipart 或对象存储表达上传，但进入 Runner 前应转换成
`Uint8Array`。持久化 input 时不要把大二进制重复存入 JSON。

## 工作区与私有目录

0.8.3 要求 Runner 显式接收：

```ts
new Runner({
  provider,
  workspace: hostWorkspace,
  runtimeDirectory: '.runtime',
});
```

`runtimeDirectory` 是 Host 选择的安全相对路径。0.8.3 目录布局：

```text
<runner workspace>/<runtimeDirectory>/conversations/
<run workspace>/<runtimeDirectory>/results/
<run workspace>/<runtimeDirectory>/history/
```

不要继续配置已经移除的 `ResultStoragePolicy.internalDirectory`。策略只保留
`maxInlineBytes`。

## 会话数据库切换

迁移到 V3 时：

1. 停止写入并备份数据库与文件资源。
2. 对每条 conversation 验证 `schemaVersion`、id 和 revision。
3. 只有已经是合法 V3 且 identity 匹配的文档可直接保留。
4. 无法无损转换的旧结构标记 legacy，提供导出或新建会话入口。
5. 删除 model thread/context usage 等双写列之前，确认没有读取者。
6. 会话整体替换改为 revision CAS。

不要在每次请求时启发式转换 V1/V2；这会让同一数据因代码版本不同得到不同历史。

## 审核恢复

恢复必须使用服务端保存的完整 checkpoint：

```ts
const decision = reviewDecisionSchema.parse(request.body);
const checkpoint = await atomicallyClaimReview(runId, decision);
await runner.resume(checkpoint, decision);
```

claim 条件至少包含 run id、`awaiting-review` 状态、review id、review revision 和未消费
标记。成功 claim 后即使后续执行失败，也不能让第二个请求消费同一 checkpoint。

V4 plan 冻结：

- target
- capability ids 与定义 fingerprint
- 实际 Skill ids、Agent ids 与 Agent 定义 fingerprint
- limits、context、result storage、validation
- workspace 与 `runtimeDirectory`
- 初始 `extraSystemPrompt`

Host 配置更新不应改变旧 checkpoint 的恢复语义。V3 checkpoint 被 0.8.3 明确拒绝。

## 事件与 SSE

- 保存原始 SDK sequence，并对 `(run_id, sequence)` 加唯一约束。
- 先持久化，后广播。
- `Last-Event-ID` 只返回更大 sequence。
- resume 若产生新的局部 sequence，Host 将其重编号接在已有 run event 后。
- 公共投影过滤 reasoning，但数据库可以保留完整审计事件。

## 推理与敏感提示

公共 API 至少删除：

- `AssistantMessage.reasoning`
- reasoning token
- tool call 内部细节（若 UI 不需要）
- Agent `systemPrompt`
- plan `extraSystemPrompt`
- validator profile 正文

过滤发生在响应投影层，不要修改权威 checkpoint，否则 resume fingerprint 或语义会损坏。

## 上线验证

- 旧 conversation 得到明确 legacy 响应，不发生 500 或静默清空。
- 两个并发 run 不能写同一 conversation。
- 两个并发 review 只有一个返回接受。
- Host 重启后仍能恢复 awaiting-review。
- SSE 断线重连无重复/缺失公共 sequence。
- 大结果和附件在新进程中 checksum 验证后恢复。
- 修改 Runner `extraSystemPrompt`/`runtimeDirectory` 不影响旧 checkpoint。
- Provider、Capability 或 Agent 更新不会绕过旧审批。
