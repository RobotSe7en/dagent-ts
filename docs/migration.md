# 迁移说明

本仓库的 TypeScript 发布线从 0.8 开始。Python Dagent 的早期版本历史不在这里重复；从
Python 迁移时请按行为契约重写 Host 和业务代码，不要逐符号替换。

## 当前发布线

| 版本  | 契约                                                            |
| ----- | --------------------------------------------------------------- |
| 0.8.3 | V3 Conversation/Run state，V4 plan/checkpoint，canonical DAG v1 |
| 0.8.0 | TypeScript 首个完整 0.8 基线                                    |

详细变更见 [CHANGELOG](../CHANGELOG.md)。

## 0.8.3

### Runner 参数

`workspace` 和 `runtimeDirectory` 现在是必填：

```ts
const runner = new Runner({
  provider,
  workspace: './workspace',
  runtimeDirectory: '.runtime',
});
```

使用 `createRunnerFromConfigFile()` 时也必须通过第二参数传入。删除
`ResultStoragePolicy.internalDirectory`；外置策略只配置 `maxInlineBytes`。

### 存储布局

私有目录统一放在 Host 选择的 runtime directory：

```text
<runner workspace>/<runtimeDirectory>/conversations
<run workspace>/<runtimeDirectory>/results
<run workspace>/<runtimeDirectory>/history
```

从旧布局迁移时应停止写入、复制资源并验证 checksum。目录现在按需创建，不能用“目录不
存在”判断功能未配置。

### `extraSystemPrompt`

Runner 新增有界、经过 schema 校验的 `extraSystemPrompt`。它作用于 ToolAgent、动态 DAG
planning/re-planning、AutoAgent 选中路径和注册 Agent，不作用于 router/validator。

每次运行将初始值冻结进 V4 plan；resume 不采用 Runner 当前值。公共 API 不返回该文本。

### Checkpoint V4

0.8.3 拒绝 V3 checkpoint。Host 应完成或导出旧等待审核 run，再升级；不要手写
fingerprint 或删除新字段。V4 仍使用 V3 conversation/run state，这是预期的独立版本。

### 会话 revision

审核后的 dynamic DAG 若执行失败、re-plan 并再次等待审核，conversation revision 现在会
推进。Host CAS 逻辑必须接受该 checkpoint 中的新 revision，不能假设一次 run 只更新会话
一次。

### 引用投影

内容、value 和 artifact references 在模型投影中有界且去重。依赖旧版重复注入行为的
prompt 应改为显式引用一次。

## 从 Python Dagent 0.8.3 迁移

### 包与语言边界

| Python 概念        | TypeScript 入口                                                |
| ------------------ | -------------------------------------------------------------- |
| Runner             | `new Runner(options)`                                          |
| function tool      | `tool({ input: zod, output: zod, execute })`                   |
| Agent config       | `defineToolAgent()` / `defineDagAgent()` / `defineAutoAgent()` |
| static DAG builder | `DagBuilder<TInput, TOutput>`                                  |
| async event stream | `for await (const event of runner.stream(...))`                |
| Pydantic boundary  | Zod schema                                                     |
| context manager    | `await using` / `try...finally`                                |

不要把 Python class hierarchy 照搬成 TypeScript class。Agent 和领域契约应保持不可变数据，
可变生命周期集中在 Runner、Manager、Store 和 Host service。

### 配置

Python YAML 字段不保证与 TS App YAML 一致。以
[`examples/dagent.yaml`](../examples/dagent.yaml) 为起点，重新填写 Provider、MCP、
Skills、Profiles、Sandbox 和模块。Python module path 不能加载到 TS Host，必须重写为
发布 ESM 的 capability module 或 MCP server。

### 数据

Python SQLite 和 TS SQLite schema 不承诺直接兼容。推荐：

1. 导出项目文件、Skill、Profile、Agent 配置和 canonical DAG。
2. 对仍需继续的会话导出完整 V3 ConversationState，并校验 identity。
3. 在隔离目录启动 TS Host。
4. 通过 API/脚本导入公开资源，重新建立 Provider/MCP 凭证。
5. 旧 awaiting-review checkpoint 不跨语言恢复，完成或关闭后再切换。

## 升级检查

```bash
pnpm install --frozen-lockfile
pnpm verify
node packages/app/dist/cli.js --version
```

升级 Host 前备份整个 `dataDirectory`，在副本上启动一次完成 migration，并验证 health、
会话详情、run event log、Skill、Provider 和 saved DAG。

## 降级

数据库 migration 和 checkpoint schema 不提供通用自动降级。需要回退时，恢复升级前的
完整数据目录备份和对应二进制；不要用旧程序打开已经迁移的活动数据库。
