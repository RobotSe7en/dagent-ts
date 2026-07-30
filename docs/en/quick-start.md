# Quick Start

This page runs a ToolAgent with the TypeScript SDK, then builds a fully typed static DAG.

## 1. Install

```bash
pnpm add dagent-ai zod
export OPENAI_API_KEY=...
```

## 2. Configure a Provider

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

A provider implements `ChatProvider`. Keep `streamIncludeUsage: false` when a compatible endpoint
does not support streamed usage.

## 3. Define a Typed Tool

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

The Zod schemas are both runtime boundaries and sources for generic inference. An invocation fails
explicitly when its input or output does not match the schema.

## 4. Run a ToolAgent

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

`RunOutcome` is a discriminated union. A run can complete, fail, be cancelled, or pause for review.
See [Conversations, Results, Streaming, and Review](results-streaming-review.md) for review handling.

## 5. Stream Events

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

`stream()` returns `AsyncIterable<RunEvent>`; no event emitter or callback registration is needed.

## 6. Build a Static DAG

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

There are no string-template references here. `ValueRef<T>` preserves dataflow types, while
`build()` produces a validated, serializable `DAGSpec`.

## Read Next

- Choose an execution mode: [Agents](agents.md)
- Learn the complete builder: [Static DAGs](static-dag.md)
- Configure YAML, MCP, profiles, and sandboxing:
  [Runner and Configuration](runner-and-configuration.md)
- Run repository examples: [examples](../../examples/README.md)
