import { Runner, defineToolAgent, tool } from 'dagent-ai';
import { OpenAICompatibleProvider } from 'dagent-ai/providers/openai-compatible';
import { z } from 'zod';

const provider = new OpenAICompatibleProvider({
  baseURL: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
  model: process.env.OPENAI_MODEL ?? 'gpt-5-mini',
  apiKeyEnv: 'OPENAI_API_KEY',
  streamIncludeUsage: false,
  contextWindowTokens: 128_000,
  outputReserveTokens: 8192,
});

const echo = tool({
  id: 'tool.echo',
  description: 'Echo typed text.',
  input: z.object({ text: z.string() }).strict(),
  output: z.object({ text: z.string() }).strict(),
  execute: ({ text }) => ({ text }),
});

await using runner = new Runner({
  provider,
  capabilities: [echo],
  workspace: './.dagent-ts',
  runtimeDirectory: '.runtime',
});
const assistant = defineToolAgent({
  kind: 'tool-agent',
  id: 'assistant',
  name: 'Assistant',
  scope: { capabilities: ['tool.echo'] },
  reviewLevel: 'never',
});

for await (const event of runner.stream(assistant, {
  prompt: 'Use echo with “hello TypeScript”, then answer.',
})) {
  if (event.type === 'token' && event.channel === 'content') {
    process.stdout.write(event.content);
  }
}
