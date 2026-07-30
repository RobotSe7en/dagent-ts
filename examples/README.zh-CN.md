# Examples

示例要求 Node.js 24，并从 workspace 使用本地 `dagent-ai`。

[English](README.md) · [简体中文文档](../docs/zh-CN/quick-start.md)

## Basic SDK

```bash
export OPENAI_API_KEY=...
export OPENAI_BASE_URL=https://api.openai.com/v1
export OPENAI_MODEL=gpt-5-mini
pnpm --filter dagent-ai build
node --experimental-strip-types examples/basic.ts
```

[`basic.ts`](basic.ts) 展示：

- OpenAI-compatible Provider
- Zod 类型化 tool
- ToolAgent
- `await using` Runner 生命周期
- `AsyncIterable<RunEvent>` 流式输出

## App configuration

[`dagent.yaml`](dagent.yaml) 是 `dagent-ai-app` 的完整起始配置：

```bash
pnpm --filter @dagent/web build
pnpm --filter dagent-ai-app build
node ../packages/app/dist/cli.js serve --config ./dagent.yaml
```

如果从仓库根目录执行，使用：

```bash
node packages/app/dist/cli.js serve --config ./examples/dagent.yaml
```

`skillRoots`、Profile、capability module 与 sandbox Skill 目录相对配置文件解析；
`dataDirectory` 和 MCP cwd 的相对值由 Host 进程 cwd 解析。
