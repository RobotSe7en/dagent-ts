import { DagBuilder, Runner, tool } from 'dagent-ai';
import { OpenAICompatibleProvider } from 'dagent-ai/providers/openai-compatible';
import { z } from 'zod';

const normalize = tool({
  id: 'tool.normalize-design-example',
  description: 'Normalize one text value.',
  input: z.object({ text: z.string() }).strict(),
  output: z.string(),
  execute: ({ text }) => text.trim().toLowerCase(),
});

const graph = new DagBuilder<{ readonly text: string }, string>({
  id: 'design-example',
  name: 'DAG design example',
  input: z.object({ text: z.string() }).strict(),
  output: z.string(),
});
const normalized = graph.capability(normalize, { text: graph.input('text') }, { id: 'normalize' });
graph.setOutput(normalized.output());
const current = graph.build();

await using runner = new Runner({
  provider: new OpenAICompatibleProvider({
    baseURL: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
    model: process.env.OPENAI_MODEL ?? 'gpt-5-mini',
    apiKeyEnv: 'OPENAI_API_KEY',
  }),
  capabilities: [normalize],
  workspace: './.dagent-ts',
});

console.log('Local diagnostics:', runner.inspectDag(current));
const result = await runner.designDag(
  'Explain this DAG. Propose a revision only if it is invalid or incomplete.',
  {
    current,
    selection: { nodeIds: ['normalize'] },
    onEvent(event) {
      console.log('Design event:', event.type);
    },
  },
);

console.log('Design result:', result.type);
if (result.type === 'proposal') console.log(result.summary, result.candidate);
if (result.type === 'no-change') console.log(result.summary);
if (result.type === 'answer') console.log(result.answer);
if (result.type === 'failure') console.error(result.diagnostics);
