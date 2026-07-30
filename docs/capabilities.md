# Capabilities

Capability 将工具、MCP、Skills 和其他可调用动作放进同一份受控目录。Agent 只看到
scope 中已启用的定义；执行仍经过输入、输出、风险和 workspace 边界。

## Capability id

id 包含 kind 前缀：

- `tool.*`：TypeScript 或内置工具
- `mcp.<server>.<tool>`：MCP 工具
- `skill.list`、`skill.view`：Skill 访问器

自定义 `tool()` 的 id 必须以 `tool.` 开头。id 是持久化计划和 checkpoint fingerprint
的一部分，发布后不要随意重命名。

## 内置能力

```ts
import { createFileTools, createMemoryTools, createShellTool } from 'dagent-ai';

const capabilities = [
  ...createFileTools(), // read_file / write_file / list_files
  ...createMemoryTools(), // memory_get / memory_set
  createShellTool(),
];
```

文件能力始终相对本次 `workspacePath` 工作，使用规范化路径和 `realpath` 防止符号链接逃逸。
shell 是高风险能力，会拒绝明确的系统级破坏命令；要获得更强隔离，可传入
`DockerSandbox`。

内存工具的 `MemoryStore` 默认属于当前进程，适合短期 Agent memory，不替代 Host 的
SQLite 会话持久化。

## TypeScript Tool

```ts
import { DagentError, Workspace, tool } from 'dagent-ai';
import { z } from 'zod';

const writeReport = tool({
  id: 'tool.write_report',
  name: 'write_report',
  description: 'Write a report in the run workspace.',
  input: z
    .object({
      path: z.string().min(1),
      content: z.string(),
    })
    .strict(),
  output: z.object({ path: z.string(), bytes: z.number().int() }).strict(),
  risk: 'medium',
  boundary: {
    workspaceWrite: true,
    allowedPaths: ['reports'],
  },
  execute: async ({ path, content }, context) => {
    if (
      !path.startsWith('reports/') ||
      path.includes('\\') ||
      path.split('/').some((part) => part === '..' || part === '.')
    ) {
      throw new DagentError('WORKSPACE_VIOLATION', 'Expected a reports/ path.');
    }
    const workspace = await Workspace.open(context.workspacePath);
    await workspace.writeFile(path, content, { overwrite: false });
    return { path, bytes: Buffer.byteLength(content) };
  },
});
```

`ToolOptions<TInput, TOutput>` 让 `execute` 参数和返回值从 Zod schema 推导。省略 output
时只保证结果为 JSON value；公共能力建议总是声明具体 output schema。

执行上下文：

```ts
type CapabilityExecutionContext = {
  readonly runId: RunId;
  readonly workspacePath: string;
  readonly signal: AbortSignal;
  readonly metadata: JsonObject;
};
```

长任务应监听 `signal`，文件操作应限制在 `workspacePath`。示例同时检查声明的
`reports/` 子边界；boundary 是可审计声明，不会替代实现内部的安全检查。

## 结构化结果

能力结果必须是 JSON-compatible。结果超过 `resultStorage.maxInlineBytes` 时，Runner 将其
原子外置，并在对话/节点结果中保留 `ContentReference`。下游 DAG 节点按 provenance
恢复原值，checksum 不匹配会失败。

tool output 不应返回函数、class instance、stream 或循环对象。文件产物使用 DAG artifact
或 Host run artifact API，不要把任意绝对路径当作跨边界数据。

## Catalog 与 Scope

```ts
runner.registerCapability(writeReport);
runner.catalog.get('tool.write_report');
runner.catalog.definitions();
runner.catalog.replace(updatedBinding);
runner.catalog.unregister('tool.write_report');
```

`register` 对重复 id 报错，`replace` 明确覆盖。Agent scope 的 capability 列表是 allowlist；
未知或禁用的 id 会在规划/执行前失败。

能力定义包含 input/output JSON Schema、risk、boundary、enabled 和 source。恢复审核时，
Runner 比较冻结定义的 fingerprint，防止审批后替换实现契约。

## MCP Tools

```ts
await runner.connectMcp({
  name: 'filesystem',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', './workspace'],
  includeTools: ['read_file'],
  risk: 'medium',
});
```

HTTP transport：

```ts
await runner.connectMcp({
  name: 'remote',
  transport: 'http',
  url: 'https://example.test/mcp',
  headers: { Authorization: `Bearer ${token}` },
});
```

MCP tool 接入后变成普通 `CapabilityBinding`。`includeTools` 与 `excludeTools` 可控制暴露
范围；server name 和 tool name 会组成稳定 id。连接中发现 id 冲突时，本次注册和连接会
整体回滚。

```ts
await runner.disconnectMcp('filesystem');
await runner.close(); // 同时关闭剩余 MCP 连接
```

## TypeScript capability modules

模块必须显式列出文件路径和导出名：

```yaml
modules:
  - path: ./capabilities/report-tools.js
    exports:
      - writeReport
```

SDK loader 只接受可验证的 `CapabilityBinding` 导出，并可将路径限制在配置 root。App
Host 还提供模块发现、上传、校验、启停和持久化 API。生产环境不要加载不受信任的
JavaScript；需要隔离的是模块本身，而不只是它调用的 shell。

## 直接测试

Capability 是普通类型化对象，可以不启动模型直接测试：

```ts
const controller = new AbortController();
await expect(
  writeReport.execute(
    { path: 'reports/a.md', content: 'hello' },
    {
      runId,
      workspacePath,
      signal: controller.signal,
      metadata: {},
    },
  ),
).resolves.toEqual({ path: 'reports/a.md', bytes: 5 });
```

测试应覆盖 schema 拒绝、路径边界、取消、输出校验和副作用幂等性。
