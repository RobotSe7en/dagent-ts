import { DagBuilder, Runner, allOf, defineStaticDag, notCondition, tool } from 'dagent-ai';
import { MockProvider } from 'dagent-ai/testing';
import { z } from 'zod';

const score = tool({
  id: 'tool.score-example',
  description: 'Score text for the routing example.',
  input: z.object({ text: z.string() }).strict(),
  output: z.object({ score: z.number() }).strict(),
  execute: ({ text }) => ({ score: text.includes('good') ? 0.9 : 0.1 }),
});

const label = tool({
  id: 'tool.label-example',
  description: 'Label one selected route.',
  input: z.object({ label: z.string(), text: z.string() }).strict(),
  output: z.string(),
  execute: ({ label: selected, text }) => `${selected}:${text}`,
});

const join = tool({
  id: 'tool.join-example',
  description: 'Join the mutually exclusive route results.',
  input: z.object({ publish: z.string().nullable(), revise: z.string().nullable() }).strict(),
  output: z.string(),
  execute: ({ publish, revise }) => publish ?? revise ?? 'no route',
});

const graph = new DagBuilder<{ readonly text: string }, string>({
  id: 'condition-routing',
  name: 'Condition routing',
  input: z.object({ text: z.string() }).strict(),
  output: z.string(),
});
const scored = graph.capability(score, { text: graph.input('text') }, { id: 'score' });
const publishCondition = {
  operator: 'gte' as const,
  left: scored.output('score').toBinding(),
  right: 0.8,
};
const route = graph.condition(
  [
    {
      branch: 'publish',
      when: allOf(
        publishCondition,
        notCondition({
          operator: 'lt',
          left: scored.output('score').toBinding(),
          right: 0.5,
        }),
      ),
    },
  ],
  'revise',
  { id: 'route', after: [scored] },
);
const published = graph.capability(
  label,
  { label: 'publish', text: graph.input('text') },
  { id: 'publish' },
);
const revised = graph.capability(
  label,
  { label: 'revise', text: graph.input('text') },
  { id: 'revise' },
);
graph.addEdge(route, published, { branch: 'publish' });
graph.addEdge(route, revised, { branch: 'revise' });
const result = graph.capability(
  join,
  { publish: published.output(), revise: revised.output() },
  { id: 'result', after: [published, revised] },
);
graph.setOutput(result.output());

await using runner = new Runner({
  provider: new MockProvider([]),
  capabilities: [score, label, join],
  workspace: './.dagent-ts',
});
const outcome = await runner.run(defineStaticDag(graph.build()), {
  graphInput: { text: 'a good TypeScript design' },
});

if (outcome.status !== 'completed') throw new Error(outcome.state.error);
console.log(outcome.output);
