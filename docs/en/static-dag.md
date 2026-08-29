# Static DAGs

A static DAG lets the host describe deterministic dataflow with a type-safe builder. The builder
produces JSON-compatible `DAGSpec`; the executor does not retain builder objects or execute code
strings from the graph.

## Minimal DAG

```ts
import { DagBuilder, defineStaticDag, tool } from 'dagent-ai';
import { z } from 'zod';

const upper = tool({
  id: 'tool.upper',
  input: z.object({ text: z.string() }).strict(),
  output: z.object({ text: z.string() }).strict(),
  execute: ({ text }) => ({ text: text.toUpperCase() }),
});

const graph = new DagBuilder({
  id: 'upper-text',
  name: 'Upper text',
  input: z.object({ text: z.string() }),
  output: z.string(),
});

const node = graph.capability(upper, { text: graph.input('text') }, { id: 'upper' });
graph.setOutput(node.output('text'));

const target = defineStaticDag(graph.build());
```

Run it:

```ts
const outcome = await runner.run(target, {
  graphInput: { text: 'hello' },
});

if (outcome.status === 'completed') console.log(outcome.output);
```

Register every capability used by the graph with the same Runner.

## Input, Output, and ValueRef

`DagBuilder<TInput, TOutput>` usually infers its generics from the input and output Zod schemas.

```ts
const source = graph.input('nested', 'value');
const full = node.output();
const field = node.output('payload').at('name');
const status = node.status();
```

At `build()`, references become `{$expr: ...}` data expressions. Runtime references are limited to
graph input, upstream node output, the current map/loop item, loop iteration, and declared
artifacts.

Arbitrary strings cannot impersonate references. A missing reference, missing dependency edge, or
cycle fails before execution.

## Dependencies and Conditions

`after` adds an edge:

```ts
const second = graph.capability(
  toolB,
  { text: first.output('text') },
  { id: 'second', after: [first] },
);
```

Add a conditional edge explicitly:

```ts
const conditional = graph.capability(toolC, { text: first.output('text') }, { id: 'conditional' });

graph.addEdge(first, conditional, {
  operator: 'eq',
  left: first.status().toBinding(),
  right: 'completed',
});
```

Conditions support `truthy`, `falsy`, `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, and `in`. A node
dataflow reference must still be dominated by a structural dependency. A condition cannot bypass
dependency validation.

Use a condition node for ordered, mutually exclusive IF/ELIF/ELSE routing. The first matching case
wins; otherwise the required default branch is selected:

```ts
import { allOf, anyOf, notCondition } from 'dagent-ai';

const passing = {
  operator: 'gte' as const,
  left: scored.output('score').toBinding(),
  right: 0.8,
};
const route = graph.condition(
  [
    {
      branch: 'publish',
      when: allOf(
        passing,
        anyOf(passing, {
          operator: 'eq',
          left: scored.output('score').toBinding(),
          right: 1,
        }),
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

graph.addEdge(route, publish, { branch: 'publish' });
graph.addEdge(route, revise, { branch: 'revise' });
```

A selected branch can fan out to several targets or end without an outgoing edge. Every outgoing
edge from a condition node must name a declared branch. Other nodes cannot originate branch edges,
and one edge cannot combine `branch` with `condition`. Execution writes `{ branch: string }` as the
condition node output and records the same value as `selectedBranch` on its node result.

## Agent Nodes

```ts
const answer = graph.agent('researcher', graph.input('question'), { id: 'research' });
graph.setOutput(answer.output());
```

`researcher` must be registered with Runner. An Agent node outputs a string. Use a capability or a
DAG with an explicit schema for more complex structures.

## Artifacts

```ts
const report = graph.artifact('report', 'reports/final.md', {
  description: 'Final Markdown report',
  required: true,
});

graph.capability(
  writeReport,
  {
    path: report.path(),
    content: graph.input('content'),
  },
  {
    id: 'write',
    artifactOutputs: [report],
  },
);
```

Artifact paths are relative to the run workspace. `artifactInputs` and `artifactOutputs` declare
node boundaries for preflight validation and runtime state tracking. Capability implementations
must still handle paths safely.

## Map

A map child graph uses `executionScope: 'map'`:

```ts
const itemGraph = new DagBuilder<Record<string, never>, string, { readonly text: string }>({
  id: 'normalize-item',
  name: 'Normalize item',
  output: z.string(),
  executionScope: 'map',
});

const normalized = itemGraph.capability(
  upper,
  { text: itemGraph.item('text') },
  { id: 'upper-item' },
);
itemGraph.setOutput(normalized.output('text'));

const mapped = graph.map(graph.input('items'), itemGraph.build(), {
  id: 'map-items',
  concurrency: 4,
  maxItems: 100,
});
```

Runner `maxConcurrency` also bounds `concurrency`. `maxItems` prevents unbounded fan-out.

## Subgraph

```ts
const nested = graph.subgraph(childGraph, { text: graph.input('text') }, { id: 'nested' });
```

A child graph has its own input, output, and structural validation while sharing the current
capability catalog, budgets, workspace, and cancellation signal.

## Loop

A loop child graph uses `executionScope: 'loop'` and can read `item()` and `iteration()`:

```ts
const checked = loopGraph.capability(
  checkDone,
  {
    value: loopGraph.item(),
    iteration: loopGraph.iteration(),
  },
  { id: 'check' },
);
loopGraph.setOutput(checked.output());

const repeated = graph.loop(
  loopGraph.build(),
  { value: graph.input('start') },
  {
    operator: 'eq',
    left: checked.output('done').toBinding(),
    right: true,
  },
  { id: 'bounded-loop', maxIterations: 10 },
);
```

A loop requires a positive `maxIterations`, with a schema maximum of 100. Pass loop state through
explicit child-graph input and output rather than process globals.

## Validation

```ts
import { assertValidDag, validateDag, validateDagInScope } from 'dagent-ai';
```

`validateDag()` returns issues and fits an editor. `assertValidDag()` throws `DagentError` and fits
an execution boundary. Builder `build()` already performs scope-aware validation.

Every declared `inputSchema` is checked as a valid, self-contained JSON Schema Draft 2020-12
document. `validateDagInput(graphOrSchema, value)` validates any JSON value without coercion or
applying defaults. Runner performs this check before creating a run workspace or emitting an event;
subgraphs and every loop iteration validate their resolved inputs before invoking child
capabilities. Failures throw `DagInputValidationError` with `path` and `schemaPath`.
