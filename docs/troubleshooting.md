# 故障排查

## 安装后无法导入

确认 Node.js 24、ESM 与公开子路径：

```bash
node --version
node -e "import('dagent-ai').then(m => console.log(typeof m.Runner))"
```

不要导入 `dagent-ai/dist/...`。pnpm workspace 中先执行 `pnpm build`；编辑器缓存旧 `.d.ts`
时重启 TypeScript server。

## Provider 认证失败

检查实际环境变量：

```bash
test -n "$OPENAI_API_KEY" && echo configured
```

Host 的 `provider.apiKeyEnv` 必须指向正确变量。`OPENAI_BASE_URL` 和 `OPENAI_MODEL` 会覆盖
YAML。某些兼容端点不支持 stream usage、reasoning 字段或特定顶层参数；先移除
`streamIncludeUsage`、`reasoning`、`extraRequestArgs` 和 `extraBody`，再逐项启用。

## Structured output 或 tool arguments 失败

0.8 不会把非法 JSON 或非对象 tool arguments 静默改写为 `{}`。错误通常意味着：

- 模型/端点不支持所需 tool calling
- schema 过于复杂
- Provider 返回了带说明文字的非 JSON 内容
- capability output 与声明的 Zod schema 不一致

保留原始 Provider 日志时要去除密钥和敏感 prompt。

## 配置文件找不到或字段被拒绝

SDK 的 `createRunnerFromConfigFile()` 和 App 的 `dagent serve --config` 使用不同 schema。
App 配置字段是 `skillRoots`、`capabilityModules`；SDK runner YAML 使用嵌套 `skills` 和
`modules`。

SDK runner YAML 的模块、Skill、Profile 和 stdio MCP cwd 以配置文件目录为基准。App 会
相对配置文件解析 `skillRoots`、Profile、capability module 与 sandbox Skill 目录；
`dataDirectory` 和 App MCP cwd 的相对值则以 Host 进程 cwd 为基准。

## 第二个 Host 无法启动

错误提示数据库被另一个进程拥有时，先检查是否已有 `dagent-ai-app` 使用同一
`dataDirectory`。不要删除仍有效的 lease 或同时启动两个 writer。确认原进程已退出后，
lease 会在 TTL 过期时被清理。

## MCP 注册失败

检查：

- stdio command 在 Host 环境可执行
- `cwd` 存在
- HTTP URL 和 headers 正确
- server name 未重复
- include/exclude tool 名匹配
- MCP 产生的 capability id 未与目录现有 id 冲突

一次连接发生冲突时 Dagent 会回滚已注册能力并断开 server。

## Unknown Capability

能力存在不代表 Agent 可见。依次检查：

1. `runner.catalog.get(id)`
2. definition `enabled`
3. Agent `scope.capabilities`
4. MCP/module 是否连接或启用
5. id 是否使用准确前缀

Dynamic DAG 会在执行前按 scope 校验，不能通过模型输出绕过 allowlist。

## Agent 看不到 Skill

确认 Skill root 存在、目录深度符合约定、`SKILL.md` 可读，且 Agent 同时拥有：

- `scope.capabilities` 中的 `skill.list` / `skill.view`
- `scope.skills` 中的 Skill name 或 qualified name

短名称在多个 category 中重复时会报 ambiguous，应改用 `category/name`。

## 静态 DAG 校验失败

常见原因：

- 重复 node/artifact id
- 图有环或边引用未知节点
- `ValueRef` 指向非上游节点
- map/loop 的 `executionScope` 错误
- `item()` 在 root graph 使用
- `iteration()` 在非 loop graph 使用
- artifact 未声明或 node boundary 不一致
- loop `maxIterations` 超过 100

在编辑器中使用 `validateDag()` 展示全部 issues；服务端执行前使用
`assertValidDag()`。

## Context window exceeded

先确认 Provider `contextWindowTokens` 和 `outputReserveTokens` 准确。再减少 Agent tool
scope、缩短 system prompt、降低 tool schema 体积或调整 context 策略。

不要把窗口数虚报得更大；这只会把错误推迟到 Provider。必要系统提示和 schemas 已超过
预算时，压缩历史无法解决。

## Review resume 失败

- `STALE_REVIEW`：id/revision 不匹配或已经消费
- `CHECKPOINT_MISMATCH`：checkpoint、能力定义、target 或资源发生变化
- `CONCURRENCY_CONFLICT`：conversation revision 被其他请求推进
- 旧 V3 checkpoint：0.8.3 只接受 V4

Host 客户端只提交 decision，不应缓存和回传裁剪后的公共 checkpoint。

## SSE 文本缺失或重复

客户端将 SSE `id` 保存为最后成功处理的 sequence，重连时发送 `Last-Event-ID`。不要同时
把 JSON event log 和 SSE 当作两条独立新消息流；两者用相同 sequence 去重。

reasoning token 被公共 API 有意过滤，因此公共 stream 与 SDK 内部 stream 的 token 数可能
不同。

## 文件或外置结果无法恢复

检查 run 使用的原始 `workspacePath`、V4 plan 中的 `runtimeDirectory`、文件权限和
checksum。不要移动单个 `results` 文件而不迁移整个运行目录。符号链接逃逸和 checksum
变化会被当作安全错误拒绝。

## Docker sandbox unavailable

```bash
docker info
curl http://127.0.0.1:8000/api/v1/sandbox/status
```

确认镜像可拉取、daemon 权限正常、workspace 可以 bind mount。sandbox 默认无网络；命令
确实需要网络时必须显式启用，并评估能力风险和 Host 环境边界。
