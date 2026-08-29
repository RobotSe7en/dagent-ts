# TypeScript SDK Reference

This page maps the public `dagent-ai` surface; it does not replace editor `.d.ts` support. Every
entry point is ESM, with runtime values and types published through the same exports map.

## Common Imports

```ts
import {
  Runner,
  DagBuilder,
  defineToolAgent,
  defineDagAgent,
  defineAutoAgent,
  defineStaticDag,
  tool,
} from 'dagent-ai';
```

## Package Subpaths

| Entry point                             | Contents                                                                     |
| --------------------------------------- | ---------------------------------------------------------------------------- |
| `dagent-ai`                             | Runner, Agent factories, DAG builder, common capabilities and contract types |
| `dagent-ai/contracts`                   | Zod schemas, contract helpers, and complete domain types                     |
| `dagent-ai/config`                      | Runner YAML schema and `createRunnerFromConfigFile()`                        |
| `dagent-ai/capabilities`                | Catalog, Workspace, built-ins, and tool helpers                              |
| `dagent-ai/mcp`                         | MCP schemas, manager, and capability-id helper                               |
| `dagent-ai/modules`                     | TypeScript capability-module loading and discovery                           |
| `dagent-ai/sandbox`                     | Docker sandbox and command execution interfaces                              |
| `dagent-ai/skills`                      | `SkillStore` and Skill capabilities                                          |
| `dagent-ai/profiles`                    | Profiles, PromptBuilder, Validator, and feedback learning                    |
| `dagent-ai/providers/openai-compatible` | OpenAI Chat Completions compatible provider                                  |
| `dagent-ai/testing`                     | Mock provider and SDK test helpers                                           |

Do not depend on package paths absent from the exports map.

## Runner

```ts
new Runner({
  provider,
  capabilities,
  agents,
  workspace,
  runtimeDirectory,
  extraSystemPrompt,
  limits,
  context,
  resultStorage,
  validation,
  skillRoots,
  managedSkillRoot,
});
```

Core methods:

```ts
runner.run(target, input, options): Promise<RunOutcome>
runner.stream(target, input, options): AsyncIterable<RunEvent>
runner.resume(checkpoint, decision, options): Promise<RunOutcome>
runner.resumeStream(checkpoint, decision, options): AsyncIterable<RunEvent>
runner.cancel(runId, reason?): boolean
runner.checkpoint(runId): RunCheckpoint | undefined
runner.close(): Promise<void>
```

Runner implements `AsyncDisposable`, so Node.js 24 supports `await using`. It defaults to
`workspace=~/.dagent` and `runtimeDirectory=.runtime`; hosts that own persistence should continue
passing both explicitly.

## Agent Factories

```ts
defineToolAgent(input): ToolAgent
defineDagAgent(input): DagAgent
defineAutoAgent(input): AutoAgent
defineStaticDag(graph, reviewLevel?): StaticDagTarget
```

Factories parse defaults and freeze their results. Agent ids must match
`^[A-Za-z][A-Za-z0-9_-]*$`.

## Typed Capabilities

```ts
const binding = tool({
  id: 'tool.example',
  input: inputSchema,
  output: outputSchema,
  risk: 'low',
  boundary: {},
  execute: async (input, context) => output,
});
```

`context` contains `runId`, `workspacePath`, an `AbortSignal`, and JSON metadata. Execution
functions should respond to cancellation and process run data only inside `workspacePath`.

`CapabilityCatalog` supports registration, replacement, removal, lookup, and scope filtering.
Duplicate registration fails explicitly. Replacing a capability invalidates older review
checkpoints whose frozen definition fingerprint no longer matches.

## DagBuilder

```ts
new DagBuilder<TInput, TOutput>({
  id,
  name,
  description?,
  input?,
  output?,
  executionScope?,
});
```

Core methods:

```ts
builder.input(...path)
builder.item(...path)
builder.iteration()
builder.artifact(id, paths, options?)
builder.capability(binding, arguments, options)
builder.agent(agentId, prompt, options)
builder.subgraph(graph, input, options)
builder.map(items, graph, options)
builder.loop(graph, input, until, options)
builder.condition(cases, defaultBranch, options)
builder.addEdge(from, to, conditionOrOptions?)
builder.setOutput(value)
builder.build()
```

`allOf(...)`, `anyOf(...)`, and `notCondition(...)` compose reusable conditions. Branch edge
options use `{ branch }`; ordinary gates remain a direct condition or `{ condition }`.

`NodeRef<T>.output()` and `ValueRef<T>.at()` preserve type relationships. Map and loop child graphs
must use the matching `executionScope` before calling `item()`. Only loop scope supports
`iteration()`.

## Public Contracts

The root entry point exports common types:

- conversation: `ConversationState`, `ConversationItem`, `Attachment`, `ContentReference`
- DAG: `DAGSpec`, `Artifact`, `ArtifactState`
- runtime: `RunState`, `RunOutcome`, `RunEvent`, `RunCheckpoint`, `ResolvedRunPlan`
- review: `PendingReview`, `ReviewDecision`
- limits: `ExecutionLimits`, `ContextPolicy`, `ResultStoragePolicy`

Zod schemas are the runtime authority for contracts. When reading network, file, or database
values, import and parse the matching schema from `dagent-ai/contracts` instead of bypassing the
boundary with a type assertion.

## Configuration Loading

The SDK includes a focused Runner YAML loader:

```ts
import { createRunnerFromConfigFile } from 'dagent-ai';

const runner = await createRunnerFromConfigFile('./runner.yaml', {
  provider,
  workspace: './workspace',
  runtimeDirectory: '.runtime',
});
```

This configuration is for an embedded SDK and supports `builtins`, `sandbox`, `skills`, `profiles`,
`validation`, `mcpServers`, `modules`, `agents`, `limits`, `context`, and `resultStorage`. It is
different from `dagent-ai-app` host YAML. See
[Runner and Configuration](runner-and-configuration.md) for the full distinction.

## Provider Interface

A custom provider implements:

```ts
interface ChatProvider {
  chat(request: ChatRequest, options?): Promise<ChatResponse>;
  streamChat(request: ChatRequest, options?): AsyncIterable<ChatStreamEvent>;
}
```

A provider adapter handles only transport and model protocol. Conversation compaction, capability
scope, DAG validation, review, and result storage belong to Runner and should not be duplicated in
the provider.

`OpenAICompatibleProvider` additionally exposes `contextWindowTokens` and `outputReserveTokens`.
Runner reads those optional implementation properties. A custom provider can expose the same
properties or configure the corresponding values explicitly in Runner options.

## Version Notes

0.9.0 uses V3 `ConversationState`/`RunState` and V4
`ResolvedRunPlan`/`RunCheckpoint`. A checkpoint is a strict resumption contract; do not hand-write,
trim, or heuristically migrate it across versions.
