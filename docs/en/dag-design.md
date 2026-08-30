# Non-Executing DAG Design

0.9.5 adds a design-only boundary for creating, revising, inspecting, and explaining a canonical
`DAGSpec`. It shares the Runner's authoritative capability and ToolAgent catalog but never invokes a
capability, creates a run or checkpoint, writes workspace files, or starts DAG execution.

## SDK API

`runner.inspectDag(spec)` performs deterministic local structural validation and returns typed
diagnostics. It does not call the model.

`runner.designDag(instruction, options)` asks the configured provider for one typed result:

- `proposal`: a complete validated candidate plus a natural-language summary;
- `no-change`: the supplied current DAG is already correct;
- `answer`: a natural-language explanation without a graph change;
- `failure`: one or more structured diagnostics.

```ts
const diagnostics = runner.inspectDag(current);
const result = await runner.designDag('Add a normalization step before publish.', {
  current,
  selection: { nodeIds: ['publish'] },
  onEvent(event) {
    console.log(event.type);
  },
});

if (result.type === 'proposal') {
  console.log(result.summary, result.candidate);
}
```

`selection.nodeIds` is a focus hint, not permission to discard the rest of the graph. Unknown ids
produce a failure. When revising, the current DAG id is retained. Candidate graphs are checked both
for canonical DAG validity and for references to capabilities/ToolAgents in the selected designer's
scope.

Lifecycle events are `response-started`, optional `reasoning-delta`, `response-finished`,
`validation-started`, and `validation-passed`. They carry a local sequence and timestamp but no
`runId`, because design is not a run. The returned V3 conversation can be passed to the next design
turn; reasoning remains isolated from later model context.

## Host and Web

The local host exposes:

- `POST /api/v1/dags/inspect` with `{ "graph": DAGSpec }`;
- `POST /api/v1/dags/design` with `instruction`, optional `agentId`, `current`, and `selection`.

The Web DAG Studio prompt bar uses these endpoints and displays the result before the user chooses
whether to save it. Validation and design do not silently execute or mutate the candidate.

The DagentWork desktop intentionally has no DAG design or DAG execution surface.
