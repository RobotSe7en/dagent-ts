# Migration Notes

The TypeScript release line begins at 0.8. Earlier Python Dagent history is not repeated here.
Migration from Python should rewrite host and business code against behavioral contracts rather
than replace symbols mechanically.

## Current Release Line

| Version | Contracts                                                                 |
| ------- | ------------------------------------------------------------------------- |
| 0.9.5   | Observable design streams, visible design responses, DagentWork desktop   |
| 0.9.4   | Non-executing DAG design and same-run approved boundary paths             |
| 0.9.3   | Artifact file manifests, V4 RunState, and V5 plans/checkpoints            |
| 0.9.2   | Resumable direct ToolAgent nodes in top-level static DAGs                 |
| 0.9.1   | Deterministic, budgeted Skill routing index in ToolAgent prompts          |
| 0.9.0   | Canonical DAG v1 with condition nodes, branch edges, and validated inputs |
| 0.8.3   | V3 Conversation/Run state and V4 plan/checkpoint                          |
| 0.8.0   | First complete TypeScript 0.8 baseline                                    |

See the [CHANGELOG](../../CHANGELOG.md) for detailed changes.

## 0.9.5

Passing `onEvent` to `runner.designDag()` consumes the provider stream and reports response and
validation lifecycle events. Calls without a listener retain the 0.9.4 non-streaming `chat`
transport. The built-in `dag_design` profile is design-only and is never exposed as an executable
capability. Returned conversations persist the natural summary, answer, or deterministic failure
message, not the provider's structured JSON.

The TypeScript workspace also adds the DagentWork local desktop. It has its own SQLite and managed
standalone workspaces and exposes only ToolAgent execution, local resources, review, files, and
observed changes. It deliberately omits every DAG and enterprise surface. See
[DagentWork Desktop](desktop.md).

The public desktop launcher package and executable are both named `dagent-work`. The earlier
unpublished `dagent-ai-desktop`/`dagent-desktop` names are not retained as aliases.

## 0.9.4

`runner.designDag()` returns a discriminated proposal/no-change/answer/failure result, and
`runner.inspectDag()` returns deterministic diagnostics. A design call may call the provider but
never invokes a capability or creates a run, review, checkpoint, result, artifact, or workspace
write. The App adds `/api/v1/dags/design` and `/api/v1/dags/inspect`; the Web DAG Studio consumes
those explicit design-only endpoints. See [Non-Executing DAG Design](dag-design.md).

Reviewable allowed-path violations now report normalized paths in `PendingReview.metadata`.
Approval authorizes only those paths for later ToolAgent calls in the same resumable run. A different
path still requires review, authorization never becomes cross-run/project/user policy, and hard
workspace escapes remain blocked. This is an intentional TypeScript contract expression of Python's
`boundary_paths`: existing metadata is extended instead of adding a parallel review payload shape.

## 0.9.3

Static-DAG input uploads now persist a sorted `ArtifactFileManifest`. The `artifact.files`
expression exposes upload-time `ArtifactFileRef` values with workspace-relative `path`, basename
`name`, byte `size`, and optional `mediaType`. It is not a workspace scan. Upload materialization
rejects traversal, duplicates, symlinked destinations, more than 256 files, a file over 25 MiB, or
more than 100 MiB total.

New runs use V4 `RunState` and V5 `ResolvedRunPlan`/`RunCheckpoint`. A legacy V4 checkpoint with V3
state remains accepted and has an explicitly empty manifest; resume never reconstructs it by
scanning files. Persist the V5 checkpoint produced by a successful continuation.

## 0.9.2

A direct top-level static-DAG agent node may target a registered ToolAgent and pause/resume its inner
tool review. The checkpoint fingerprints the direct Agent configuration and suspended invocation.
Ordinary static capability nodes remain directly authorized by the graph author. Agent nodes inside
subgraphs, maps, or loops are rejected before execution because nested progress is not yet safely
restorable.

## 0.9.1

ToolAgent prompts include a deterministic, sorted index for their resolved Skill scope. Complete
name/description entries have an 8,000-character budget, name-only fallbacks have a separate
2,000-character budget, and omitted entries direct the model to `skill.list`. Full `SKILL.md`
content remains loaded on demand with `skill.view`; dynamic DAG planner prompts are unchanged.

## 0.9.0

### Condition Routing

`DagNode` adds the `kind: "condition"` variant with ordered `cases` and a required
`defaultBranch`. `DagEdge.branch` connects the selected branch to one or more downstream nodes;
`DagNodeResult.selectedBranch` persists the decision. Hosts and exhaustive decoders must accept
these optional/new variants before loading a 0.9 DAG or checkpoint.

Use `DagBuilder.condition(...)` and `addEdge(..., { branch })`. `allOf`, `anyOf`, and
`notCondition` compose conditions. Ordinary `condition` edges remain independent gates: a branch
edge must originate at a condition node, and one edge cannot declare both forms.

### Static Input And Output

Static `graphInput` now accepts any `JsonValue`. Declared input schemas must be valid,
self-contained JSON Schema Draft 2020-12 documents. Runner validates root input before workspace
creation and validates resolved subgraph and loop inputs before child capability execution.
`DagInputValidationError` exposes instance `path` and `schemaPath`.

Exact structured static output remains available as `RunOutcome.output` and in V3 run state and V4
checkpoints. No stored-DAG database migration is required.

### Runner Defaults And Profiles

`workspace` and `runtimeDirectory` are now optional and default to `~/.dagent` and `.runtime`.
Storage-owning hosts should keep passing explicit values. The built-in `conversation` profile is
now limited to direct response and bounded tool selection; DAG planning remains owned by DagAgent.

### Compatibility

Existing capability, agent, subgraph, map, loop, and ordinary conditional-edge graphs retain their
behavior. The canonical schema version remains 1, and conversation/checkpoint versions remain V3
and V4. The breaking surface is limited to consumers that exhaustively decode node/edge/result
unions without accepting the 0.9 variants.

## 0.8.3

### Runner Options

`workspace` and `runtimeDirectory` are required:

```ts
const runner = new Runner({
  provider,
  workspace: './workspace',
  runtimeDirectory: '.runtime',
});
```

Pass both through the second argument to `createRunnerFromConfigFile()` as well. Remove
`ResultStoragePolicy.internalDirectory`; externalization policy now configures only
`maxInlineBytes`.

### Storage Layout

Private directories live under the host-selected runtime directory:

```text
<runner workspace>/<runtimeDirectory>/conversations
<run workspace>/<runtimeDirectory>/results
<run workspace>/<runtimeDirectory>/history
```

When moving an older layout, stop writes, copy resources, and verify checksums. Directories are now
lazy; absence of a directory no longer proves a feature is unconfigured.

### `extraSystemPrompt`

Runner adds a bounded, schema-validated `extraSystemPrompt`. It applies to ToolAgent, dynamic DAG
planning and re-planning, the selected AutoAgent path, and registered Agents. It does not apply to
router or validator classifiers.

Each run freezes its initial value in the V4 plan. Resumption does not use the current Runner value,
and public APIs do not return the text.

### Checkpoint V4

0.8.3 rejects V3 checkpoints. Complete or export older review-pending runs before upgrading. Do
not hand-build fingerprints or delete new fields. V4 still contains V3 conversation/run state;
these are intentionally independent contract versions.

### Conversation Revision

If reviewed dynamic DAG execution fails, re-plans, and waits for another review, the conversation
revision now advances. Host CAS logic must accept the new revision in the checkpoint and must not
assume one run updates a conversation only once.

### Reference Projection

Content, value, and artifact references are bounded and deduplicated in model projections. Prompts
that relied on earlier duplicate injection should reference content explicitly once.

## Migrating from Python Dagent 0.9.5

### Package and Language Boundaries

| Python concept                    | TypeScript entry                                               |
| --------------------------------- | -------------------------------------------------------------- |
| Runner                            | `new Runner(options)`                                          |
| function tool                     | `tool({ input: zod, output: zod, execute })`                   |
| Agent config                      | `defineToolAgent()` / `defineDagAgent()` / `defineAutoAgent()` |
| static DAG builder                | `DagBuilder<TInput, TOutput>`                                  |
| `ConditionNode`                   | `builder.condition(...)` plus `{ branch }` edge options        |
| `all_of` / `any_of` / `not_`      | `allOf` / `anyOf` / `notCondition`                             |
| async event stream                | `for await (const event of runner.stream(...))`                |
| `design_dag` / `inspect_dag_spec` | `runner.designDag()` / `runner.inspectDag()`                   |
| Pydantic boundary                 | Zod schema                                                     |
| context manager                   | `await using` / `try...finally`                                |

Do not reproduce a Python class hierarchy as TypeScript classes. Agents and domain contracts should
remain immutable data. Mutable lifecycles belong to Runner, Manager, Store, and host services.

### Configuration

Python YAML fields do not promise compatibility with App YAML. Start from
[`examples/dagent.yaml`](../../examples/dagent.yaml) and re-enter provider, MCP, Skills, profiles,
sandbox, and modules. A Python module path cannot load into the TypeScript host; rewrite it as a
published ESM capability module or MCP server.

### Data

Python and TypeScript SQLite schemas do not promise direct compatibility. Recommended process:

1. Export project files, Skills, profiles, Agent configuration, and canonical DAGs.
2. Export a complete identity-validated V3 ConversationState for conversations that must continue.
3. Start the TypeScript host in an isolated directory.
4. Import public resources through APIs or scripts and recreate provider/MCP credentials.
5. Do not resume older awaiting-review checkpoints across languages; complete or close them before
   cutover.

## Upgrade Check

```bash
pnpm install --frozen-lockfile
pnpm verify
node packages/app/dist/cli.js --version
```

Back up the entire `dataDirectory`, start a copy once to run migrations, then verify health,
conversation details, run event logs, Skills, providers, and saved DAGs.

## Downgrade

Database migrations and checkpoint schemas do not provide general automatic downgrade. To roll
back, restore the complete pre-upgrade data-directory backup with its matching binary. Never open
an already migrated active database with an older program.
