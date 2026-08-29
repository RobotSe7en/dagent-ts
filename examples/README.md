# Examples

Examples require Node.js 24 and use the local `dagent-ai` workspace package.

[简体中文](README.zh-CN.md) · [Documentation](../docs/en/quick-start.md)

## Basic SDK

```bash
export OPENAI_API_KEY=...
export OPENAI_BASE_URL=https://api.openai.com/v1
export OPENAI_MODEL=gpt-5-mini
pnpm --filter dagent-ai build
node --experimental-strip-types examples/basic.ts
```

[`basic.ts`](basic.ts) demonstrates:

- the OpenAI-compatible provider
- a Zod-typed tool
- ToolAgent
- the `await using` Runner lifecycle
- `AsyncIterable<RunEvent>` streaming output

## Condition Routing

```bash
pnpm --filter dagent-ai build
node --experimental-strip-types examples/condition-routing.ts
```

[`condition-routing.ts`](condition-routing.ts) is an offline static-DAG example with ordered cases,
composable conditions, mutually exclusive branch edges, and exact structured output.

## App Configuration

[`dagent.yaml`](dagent.yaml) is a complete starting configuration for `dagent-ai-app`:

```bash
pnpm --filter @dagent/web build
pnpm --filter dagent-ai-app build
node ../packages/app/dist/cli.js serve --config ./dagent.yaml
```

From the repository root:

```bash
node packages/app/dist/cli.js serve --config ./examples/dagent.yaml
```

`skillRoots`, profiles, capability modules, and sandbox Skill directories resolve relative to the
configuration file. Relative `dataDirectory` and MCP cwd values resolve from the host process
working directory.
