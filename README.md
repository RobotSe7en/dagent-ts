# Dagent TypeScript

Dagent 是面向 TypeScript 的类型安全 Agent 与 DAG 运行时。本仓库不是 Python
版本的逐行翻译：核心模型重新划分为不可变契约、能力目录、执行运行时、持久化应用和
模块化 Web UI。

> `reference/dagent/` 是与上游 0.8.0 工作树同步的只读 Python 参考副本，不参与构建或提交。

## 工作区

- `packages/sdk` — 发布为 `dagent-ai`，纯 SDK、DAG builder、运行时、MCP、
  Skills、TS 工具模块及 Docker 沙箱。
- `packages/app` — 发布为 `dagent-ai-app`，Fastify API、Kysely/SQLite
  持久化、CLI 和内嵌 Web UI。
- `apps/web` — React 工作台；构建产物写入 `packages/app/web`。
- `examples` — SDK 和配置示例。
- `docs` — 架构、历史消息与 API 说明。

## 快速开始

要求 Node.js 24 和 pnpm 10。

```bash
pnpm install
pnpm verify

export OPENAI_API_KEY=...
export OPENAI_MODEL=gpt-5-mini
pnpm --filter @dagent/web build
pnpm --filter dagent-ai-app build
node packages/app/dist/cli.js serve
```

默认监听 `127.0.0.1:8000`，数据写入 `~/.dagent-ts`。也可以通过
`dagent serve --config ./dagent.yaml` 加载配置。

## SDK 示例

```ts
import { Runner, defineToolAgent, tool } from 'dagent-ai';
import { OpenAICompatibleProvider } from 'dagent-ai/providers/openai-compatible';
import { z } from 'zod';

const echo = tool({
  id: 'tool.echo',
  input: z.object({ text: z.string() }),
  output: z.object({ text: z.string() }),
  execute: ({ text }) => ({ text }),
});

const runner = new Runner({
  provider: new OpenAICompatibleProvider({
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-5-mini',
    apiKeyEnv: 'OPENAI_API_KEY',
    // 兼容端点默认不发送 stream_options；确认支持后再开启。
    streamIncludeUsage: false,
  }),
  capabilities: [echo],
});

const agent = defineToolAgent({
  kind: 'tool-agent',
  id: 'assistant',
  name: 'Assistant',
  scope: { capabilities: ['tool.echo'] },
});

const outcome = await runner.run(agent, { prompt: 'Echo hello.' });
await runner.close();
```

更多细节见 [架构说明](docs/architecture.md)、
[会话历史设计](docs/conversation-history.md) 和 [HTTP API](docs/http-api.md)。

OpenAI-compatible Provider 默认使用兼容性更好的 `json_object` 结构化输出，并在本地用
请求中的 JSON Schema 严格校验结果。`extraRequestArgs` 用于顶层 provider 参数，
`extraBody` 用于请求体扩展；两者均为有类型的 JSON 对象。模型返回非法 JSON 或非对象
形式的工具参数时会明确失败，不会静默改写成空对象。

## 设计原则

- 模型只产生符合 JSON Schema 的 DAG，不执行或回传任意代码。
- 所有能力拥有统一定义、输入/输出校验、风险等级和边界声明。
- V3 `ConversationState` 是唯一权威会话；推理和内部项可审计，但不会回放进后续模型上下文，
  公共 API 只投影用户可见项。
- 高风险能力和 DAG 可形成精确、带版本的审核检查点。
- 本地文件访问使用词法边界与真实路径双重校验。
- SSE 事件先持久化再广播，客户端可用 `Last-Event-ID` 恢复。

许可证：Apache-2.0。
