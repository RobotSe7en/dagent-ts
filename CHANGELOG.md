# Changelog

## 0.9.5

- Made non-executing DAG design streams observable through typed response and validation events
  when an event listener is supplied, while retaining the non-streaming provider path otherwise.
- Added the dedicated non-executable `dag_design` profile and persisted natural summaries, answers,
  or deterministic failure messages in returned design conversations.
- Added DagentWork, a secured local-first Electron ToolAgent workbench with project/standalone
  conversations, review, file previews, observed before/after changes, model/MCP/Skill/ToolAgent
  resources, isolated SQLite state, and no DAG or enterprise surfaces.
- Added the `dagent-work` launcher and six optional native payload packages for macOS, Linux,
  and Windows on x64 and arm64, plus a matrix release workflow.
- Named the private Electron workspace package `@dagent/work` and added `pnpm dagent-work:dev` as
  the source-development entrypoint.
- Fixed reviewed static ToolAgent resume finalization and result externalization, directory-mode
  artifact manifests, and short-name Skill routing indexes.
- Fixed DagentWork persisted-review subscriptions, stale review/live-output rendering, and bounded
  workspace scanning; removed the unsupported direct ToolAgent delegate selector.

## 0.9.4

- Added typed, non-executing `Runner.designDag()` proposal/no-change/answer/failure results,
  deterministic `Runner.inspectDag()` diagnostics, and response/validation lifecycle contracts.
- Added explicit `/api/v1/dags/design` and `/api/v1/dags/inspect` host routes and integrated the Web
  DAG Studio prompt bar without executing or mutating a proposed graph.
- Reused explicitly approved normalized boundary paths only within the same ToolAgent run while
  continuing to review different paths and reject hard workspace escapes.

## 0.9.3

- Added public artifact input file manifests and `artifact.files` expressions as deterministic,
  upload-time snapshots with path, name, size, and optional media type.
- Bounded static artifact materialization to 256 files, 25 MiB per file, and 100 MiB total, with
  traversal, duplicate-target, overlap, and symlink validation before writes.
- Advanced new run state to V4 and resolved plans/checkpoints to V5, while preserving explicit V4
  checkpoint/V3 state restoration with an empty legacy file manifest.

## 0.9.2

- Added review and deterministic resume for direct top-level ToolAgent nodes in static DAGs,
  including suspended invocation state and Agent-definition fingerprints.
- Rejected Agent nodes nested inside subgraphs, maps, or loops before execution because their
  progress cannot yet be safely restored; ordinary static capability nodes retain prior behavior.

## 0.9.1

- Added a deterministic, budgeted Available Skills index to ToolAgent prompts, with complete
  name/description entries, name-only fallbacks, omitted counts, and `skill.list` guidance.
- Kept full Skill bodies on demand through `skill.view` and left dynamic DAG planner prompts
  unchanged.

## 0.9.0

- Added first-class condition nodes, ordered cases, exclusive branch edges, branch fan-out, and
  persisted `selectedBranch` results across static, dynamically planned, saved, and resumed DAGs.
- Added composable `allOf`, `anyOf`, and `notCondition` predicates while retaining ordinary edge
  conditions for independent gates.
- Added self-contained JSON Schema Draft 2020-12 validation for DAG input schemas and typed graph
  input errors before workspace creation or execution; nested subgraphs and every loop iteration
  validate their resolved input as well.
- Generalized static graph input from object-only values to any JSON value and retained exact
  structured static output through `RunOutcome.output`, run state, checkpoints, and host APIs.
- Defaulted SDK Runner storage to `~/.dagent` and `.runtime` when the host does not select explicit
  paths, and corrected the built-in conversation profile to contain only bounded tool-loop
  guidance.
- Updated the Fastify host, React DAG projection, bilingual documentation, examples, and version
  metadata for the 0.9 contract.

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
