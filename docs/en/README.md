# Dagent TypeScript Documentation

This directory contains the default English documentation for `dagent-ai`, the
`dagent-ai-app` local host, and the React workbench.

Simplified Chinese documentation is available at [docs/zh-CN](../zh-CN/README.md).

## Start Here

| Page                                          | Read it when                                                         |
| --------------------------------------------- | -------------------------------------------------------------------- |
| [Installation](installation.md)               | Preparing Node.js, pnpm, a provider, or a source checkout            |
| [Quick Start](quick-start.md)                 | Building a first ToolAgent and typed static DAG                      |
| [Core Concepts](concepts.md)                  | Learning Runner, Agent, Capability, DAG, Skill, and review semantics |
| [TypeScript SDK Reference](typescript-sdk.md) | Locating public exports, package subpaths, and common signatures     |
| [Examples](../../examples/README.md)          | Running the repository TypeScript and YAML examples                  |

## Feature Guides

| Topic                                                     | Page                                                                         |
| --------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Runner, provider, YAML, MCP, profiles, sandbox            | [Runner and Configuration](runner-and-configuration.md)                      |
| ToolAgent, DagAgent, AutoAgent                            | [Agents](agents.md)                                                          |
| Built-ins, TypeScript tools, MCP, boundaries              | [Capabilities](capabilities.md)                                              |
| `DagBuilder`, references, map, subgraph, loop             | [Static DAGs](static-dag.md)                                                 |
| Skill roots, managed installs, Skill capabilities         | [Skills](skills.md)                                                          |
| Multi-turn state, context, streams, large results, review | [Conversations, Results, Streaming, and Review](results-streaming-review.md) |
| V3 authoritative history and public projections           | [Conversation History and Context](conversation-history.md)                  |
| SDK, host, database, and Web boundaries                   | [Architecture](architecture.md)                                              |

## Host and Operations

| Topic                                           | Page                                            |
| ----------------------------------------------- | ----------------------------------------------- |
| SQLite, projects, recovery, single-writer model | [Host Persistence](api-backend-persistence.md)  |
| REST, SSE, errors, and resource routes          | [HTTP API](http-api.md)                         |
| 0.8 host data and request migration             | [SDK 0.8 Host Migration](host-migration-0.8.md) |
| Version differences and upgrade work            | [Migration Notes](migration.md)                 |
| Common configuration and runtime failures       | [Troubleshooting](troubleshooting.md)           |

## Documentation Conventions

- Examples assume ESM, strict TypeScript, Node.js 24, and Zod 4.
- SDK runtime paths are written as `<workspace>/<runtimeDirectory>`; host storage is written as
  `<dataDirectory>`.
- `DAGSpec`, `ConversationState`, and `RunCheckpoint` refer to public versioned contracts.
- Internal implementation plans are not product documentation. Design pages describe released,
  verifiable behavior.

See the [CHANGELOG](../../CHANGELOG.md) and [Migration Notes](migration.md) for version changes.
