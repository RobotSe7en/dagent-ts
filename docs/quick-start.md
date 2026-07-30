# 快速开始

本页先用 TypeScript SDK 运行 ToolAgent，再构建一个完全类型化的静态 DAG。

## 1. 安装

```bash
pnpm add dagent-ai zod
export OPENAI_API_KEY=...
```

## 2. 配置 Provider

```ts
import { OpenAICompatibleProvider } from 'dagent-ai/providers/openai-compatible';

const provider = new OpenAICompatibleProvider({
  baseURL: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
  model: process.env.OPENAI_MODEL ?? 'gpt-5-mini',
  apiKeyEnv: 'OPENAI_API_KEY',
  contextWindowTokens: 128_000,
  outputReserveTokens: 8192,
});
```

Provider 实现 `ChatProvider` 接口。兼容端点不支持 streamed usage 时，保持
`streamIncludeUsage: false`。

## 3. 定义类型化 Tool

```ts
import { tool } from 'dagent-ai';
import { z } from 'zod';

const lookupWeather = tool({
  id: 'tool.lookup_weather',
  name: 'lookup_weather',
  description: 'Look up a deterministic demo forecast.',
  input: z.object({ city: z.string().min(1) }).strict(),
  output: z
    .object({
      city: z.string(),
      condition: z.string(),
      temperatureC: z.number(),
    })
    .strict(),
  risk: 'low',
  execute: ({ city }) => ({
    city,
    condition: 'sunny',
    temperatureC: 26,
  }),
});
```

Zod schema 同时提供运行时边界与泛型推导。输入和输出不符合 schema 时，调用会明确
失败。

## 4. 运行 ToolAgent

```ts
import { Runner, defineToolAgent } from 'dagent-ai';

const agent = defineToolAgent({
  kind: 'tool-agent',
  id: 'weather_assistant',
  name: 'Weather assistant',
  description: 'Answers weather questions with registered tools.',
  systemPrompt: 'Use tools for weather facts.',
  scope: { capabilities: ['tool.lookup_weather'] },
  reviewLevel: 'never',
  maxSteps: 8,
});

await using runner = new Runner({
  provider,
  capabilities: [lookupWeather],
  workspace: './.dagent-ts',
  runtimeDirectory: '.runtime',
});

const outcome = await runner.run(agent, {
  prompt: 'What is the weather in Hangzhou?',
});

if (outcome.status === 'completed') {
  console.log(outcome.output);
}
```

`RunOutcome` 是判别联合。运行可能完成、失败、取消或暂停等待审核；处理审核见
[会话、结果、流式与审核](results-streaming-review.md)。

## 5. 使用流式事件

```ts
for await (const event of runner.stream(agent, {
  prompt: 'What is the weather in Shanghai?',
})) {
  switch (event.type) {
    case 'token':
      if (event.channel === 'content') process.stdout.write(event.content);
      break;
    case 'review-required':
      console.log('Review required:', event.review);
      break;
    case 'run-completed':
      console.log('\nStatus:', event.outcome.status);
      break;
  }
}
```

`stream()` 返回 `AsyncIterable<RunEvent>`，不用事件发射器，也无需额外回调注册。

## 6. 构建静态 DAG

```ts
import { DagBuilder, defineStaticDag } from 'dagent-ai';
import { z } from 'zod';

const inputSchema = z.object({ city: z.string() }).strict();
const outputSchema = z.object({
  city: z.string(),
  summary: z.string(),
});

const summarize = tool({
  id: 'tool.summarize_weather',
  input: z
    .object({
      city: z.string(),
      condition: z.string(),
      temperatureC: z.number(),
    })
    .strict(),
  output: outputSchema,
  execute: ({ city, condition, temperatureC }) => ({
    city,
    summary: `${condition}, ${temperatureC} °C`,
  }),
});

const graph = new DagBuilder({
  id: 'weather-report',
  name: 'Weather report',
  input: inputSchema,
  output: outputSchema,
});

const weather = graph.capability(lookupWeather, { city: graph.input('city') }, { id: 'lookup' });
const report = graph.capability(
  summarize,
  {
    city: weather.output('city'),
    condition: weather.output('condition'),
    temperatureC: weather.output('temperatureC'),
  },
  { id: 'summarize', after: [weather] },
);
graph.setOutput(report.output());

const staticTarget = defineStaticDag(graph.build());
runner.registerCapability(summarize);
const result = await runner.run(staticTarget, { graphInput: { city: 'Suzhou' } });
```

这里没有字符串模板引用。`ValueRef<T>` 保留 dataflow 类型，`build()` 产生可序列化且经过
校验的 `DAGSpec`。

## 接下来读什么

- 了解三种执行模式：[Agents](agents.md)
- 掌握完整 builder：[静态 DAG](static-dag.md)
- 配置 YAML、MCP、Profiles 和 Sandbox：[Runner 和配置](runner-and-configuration.md)
- 直接运行仓库示例：[examples](../examples/README.md)
