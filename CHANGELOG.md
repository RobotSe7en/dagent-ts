# Changelog

## 0.8.0

- Rebuilt the SDK around immutable TypeScript discriminated unions, Zod boundary parsing, typed
  capabilities, canonical DAG execution, resumable review checkpoints, and structured run events.
- Added the canonical bounded V3 `ConversationState`, context budgeting and compaction, typed
  attachments, durable conversation resources, reasoning isolation, and public conversation
  projections.
- Added content-addressed result externalization with checksum verification and transparent
  in-memory rehydration for downstream DAG nodes, maps, loops, and resumed runs.
- Added capability-definition fingerprints, frozen execution/model limits, duplicate review
  protection, and host-side atomic review claims plus conversation revision CAS.
- Added the unified Fastify/SQLite application and React workbench with resumable SSE, projects,
  conversations, DAGs, model/MCP/capability management, uploads, artifacts, and local document
  integration.
- Aligned the OpenAI-compatible provider with the 0.8 contract: opt-in streamed usage,
  `json_object` structured requests with local schema validation, explicit invalid tool-argument
  failures, reasoning controls, and typed provider extension arguments.
