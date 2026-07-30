# Agents

An Agent is an immutable declaration, not a runtime base class to extend. Choose one by task
structure first, then by review and capability boundaries.

## Choosing an Agent

| Mode      | Best for                                                                   | Primary bound                          |
| --------- | -------------------------------------------------------------------------- | -------------------------------------- |
| ToolAgent | Short tasks, interactive tool selection, steps driven by immediate results | `maxSteps`                             |
| DagAgent  | Multi-step or parallel work, plan review, local re-planning after failure  | `maxReplans`                           |
| AutoAgent | One entry point for both simple and complex requests                       | Embedded ToolAgent and DagAgent limits |
| StaticDag | A workflow already known by the host                                       | Graph node and loop limits             |

Prefer a static DAG when the host can express the workflow directly. Use DagAgent when only the
model can determine the workflow after seeing the user's goal. Do not hand deterministic business
logic to a model merely to make it “agentic.”

## ToolAgent

```ts
import { defineToolAgent } from 'dagent-ai';

const assistant = defineToolAgent({
  kind: 'tool-agent',
  id: 'assistant',
  name: 'Assistant',
  description: 'Handles focused workspace tasks.',
  systemPrompt: 'Use tools for external facts and state changes.',
  scope: {
    capabilities: ['tool.read_file', 'tool.write_file'],
    skills: ['writing/release-notes'],
    agents: [],
  },
  reviewLevel: 'risky',
  maxSteps: 20,
});
```

ToolAgent exposes enabled capabilities in its scope to the provider. The model can make consecutive
calls until it answers, enters review, fails, or reaches `maxSteps`.

`reviewLevel`:

- `never`: policy does not request human review.
- `risky`: high- and critical-risk capabilities require review.
- `always`: every capability invocation requires review.

Review never bypasses schema, scope, or boundary validation.

## DagAgent

```ts
import { defineDagAgent } from 'dagent-ai';

const planner = defineDagAgent({
  kind: 'dag-agent',
  id: 'planner',
  name: 'Planner',
  description: 'Plans and executes multi-step work.',
  scope: {
    capabilities: ['tool.read_file', 'tool.write_file', 'tool.shell'],
  },
  reviewLevel: 'risky',
  maxReplans: 3,
});
```

DagAgent requests a structured plan and normalizes it into canonical `DAGSpec`. The runtime
validates the graph, capability allowlist, and dataflow before execution. After a node failure, the
planner receives completed nodes and failure context and may propose a replacement graph within
`maxReplans`. Completed nodes are not repeated without cause.

When policy requires DAG confirmation, Runner returns `awaiting-review` and stores the proposed
graph in a checkpoint. Resumption can approve, reject, or supply a `replacementGraph` for DAG
review.

## AutoAgent

```ts
import { defineAutoAgent } from 'dagent-ai';

const automatic = defineAutoAgent({
  kind: 'auto-agent',
  id: 'automatic',
  name: 'Automatic assistant',
  scope: {},
  reviewLevel: 'risky',
  toolAgent: assistant,
  dagAgent: planner,
});
```

The AutoAgent router decides only whether to use ToolAgent or DagAgent. After selection, the
runtime uses the embedded Agent's scope and limits. `Runner.extraSystemPrompt` applies to the
selected execution Agent, not to the routing classifier, so host response rules do not distort the
classification.

## Registration and Direct Runs

```ts
const runner = new Runner({
  provider,
  agents: [assistant, planner],
  workspace: './workspace',
  runtimeDirectory: '.runtime',
});

runner.registerAgent(automatic);
runner.replaceAgent(updatedAgent);
runner.unregisterAgent('old_agent');

await runner.run(assistant, { prompt: 'Summarize README.md' });
```

An `agent` node in a static DAG resolves its id through Runner, so that child Agent must be
registered. An Agent passed directly as the `run()` target does not need prior registration.

A duplicate `registerAgent()` call fails; `replaceAgent()` explicitly communicates that the host
accepts replacement. Checkpoint resumption uses the frozen target and capability definitions, not
the current Agent that happens to share an id.

## Shared Fields

- `id`: stable identifier beginning with a letter and containing letters, digits, `_`, or `-`
- `name`: user-facing name
- `description`: helps a router or planner understand responsibility
- `systemPrompt`: durable instructions owned by the Agent
- `scope`: capability, Skill, and Agent allowlists
- `reviewLevel`: `never`, `risky`, or `always`
- `context`: overrides for the default compaction policy

`Runner.extraSystemPrompt` is a host-level addition and should not be copied into every Agent. It
is frozen into the V4 plan when a run starts; resumption does not read the current Runner value.

## Multi-turn Continuation

Pass `state.conversation` from the previous outcome into the next run:

```ts
const first = await runner.run(assistant, { prompt: 'Remember project Alpha.' });
const second = await runner.run(assistant, {
  prompt: 'Which project did I mention?',
  conversation: first.state.conversation,
});
```

Do not send provider message arrays or the trimmed public API projection back to the SDK. See
[Conversation History and Context](conversation-history.md) for the complete rules.
