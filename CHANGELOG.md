# Changelog

## 0.8.3

- Added a validated runner-level `extraSystemPrompt` that is frozen into V4 run plans and applied
  to ToolAgent, dynamic DAG planning/replanning, selected AutoAgent execution, and registered
  agents without affecting routing or validation classifiers.
- Advanced canonical conversation revisions when reviewed dynamic DAG execution fails, replans,
  and reaches another review boundary.
- Made `workspace` and `runtimeDirectory` explicit SDK inputs, moved private conversation, result,
  and restored-history data under the host-selected runtime directory, and removed
  `ResultStoragePolicy.internalDirectory`.
- Upgraded resumable plans and checkpoints to V4 while retaining V3 run/conversation state,
  preserving pre-`extraSystemPrompt` V4 fingerprints, and rejecting V3 checkpoints.
- Added lazy private-directory creation, verified in-place continuation resources, and bounded,
  de-duplicated model projection for content, value, and artifact references.

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
