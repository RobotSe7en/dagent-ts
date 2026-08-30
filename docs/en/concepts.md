# Core Concepts

## Runner

`Runner` is the lifecycle and execution boundary of the SDK. It owns:

- a `ChatProvider`
- a `CapabilityCatalog`
- registered Agents
- MCP connections and the SkillStore
- context budgets, execution limits, and result externalization policy
- active runs, review checkpoints, and cancellation controllers

Runner does not own HTTP, SQLite, or browser state. Applications can embed the SDK directly or use
`dagent-ai-app` as a persistent host.

## Declarative Agents

An Agent is a Zod-parsed, frozen data object rather than a class to extend:

- `ToolAgent` lets the model select capabilities in a bounded loop.
- `DagAgent` asks the model for a canonical `DAGSpec` and can re-plan locally after failure.
- `AutoAgent` routes to a ToolAgent or DagAgent and executes the selected target.

Shared fields include id, name, description, system prompt, capability scope, review level, and
context policy. Create Agents with `defineToolAgent()`, `defineDagAgent()`, and
`defineAutoAgent()`. Register them with Runner or pass them directly to `run()`.

## Tool Loops and Dynamic DAGs

ToolAgent fits short, interactive work in which each next step depends on the latest result.
DagAgent fits multi-step or parallel work that benefits from an up-front plan and local recovery
after failure.

The dynamic planner emits structured DAG data only. Schema, graph structure, capability scope,
expression dependencies, artifacts, and limits are validated before the graph reaches
`DagExecutor`. The model never produces TypeScript for direct execution.

## Static DAGs

A static DAG fits a workflow already known by the host. `DagBuilder<TInput, TOutput>` connects
nodes through generic `ValueRef<T>` values and produces the same `DAGSpec` as the dynamic planner.

Node kinds:

- `capability` invokes a catalog binding
- `agent` invokes a registered Agent
- `subgraph` executes a nested graph
- `map` executes a child graph concurrently over a bounded list
- `loop` executes a child graph until a condition succeeds or its iteration limit is reached

A static graph is pure data: it can be validated, persisted, visualized by the Web application,
and executed in another process.

## Capabilities

Capability is the common abstraction for external actions. A
`CapabilityBinding<TInput, TOutput>` contains:

- a stable capability id
- kind, description, risk, boundary, and source metadata
- Zod input and output schemas
- a typed `execute(input, context)` function

TypeScript tools, built-in file/shell/memory actions, MCP tools, and Skill accessors enter the same
`CapabilityCatalog`. Agent scope references capability ids and never owns execution functions.

## Skills

A Skill is a directory with a `SKILL.md` file that gives an Agent discoverable instructions and
related files. Runner exposes SkillStore through controlled capabilities, so a model must list and
then read only permitted files.

Skills and tools have different boundaries: Skills primarily communicate method and context,
while tools execute structured actions. A mature integration can provide both Skill guidance and
tool implementations.

## Conversation, Result, and State

The V3 `ConversationState` is the sole authoritative multi-turn history. It stores user,
assistant, tool-result, and internal audit items, then projects them by scope and visibility into:

- bounded provider context
- a user-visible conversation for public HTTP clients

Large results are written to `<run workspace>/<runtimeDirectory>/results`. History stores their
checksum, preview, and provenance, and downstream nodes restore them transparently when needed.
Ordinary user JSON is never guessed to be an internal reference.

`RunState` describes current execution, `RunOutcome` describes a call result, and `RunEvent`
describes the ordered process. When review pauses a run, a V5 `RunCheckpoint` freezes the target,
capability-definition fingerprints, limits, runtime directory, initial additional system prompt,
and conversation state.

## Host

`dagent-ai-app` wraps the SDK as a local application:

```text
React Web ── REST/SSE ── Fastify ── services ── repositories ── SQLite
                                  └── Runner
```

The host uses a single-writer lease, SQLite WAL, conversation revision CAS, atomic review claims,
and persistent event sequences for recovery. It is not required by the SDK, but provides a unified
entry point for desktop-style and local Web workflows.
