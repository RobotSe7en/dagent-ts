# SDK 0.8 Host Migration

This page is for host authors who embed `dagent-ai` directly. `dagent-ai-app` handles database
structure through Kysely migrations, but operators should still back up the complete data
directory.

## Persistence Boundary

A 0.8 host should persist:

- complete V3 `ConversationState`
- latest V4 `RunCheckpoint`
- original, sequence-ordered `RunEvent`
- run target and redacted input metadata
- project/workspace ownership and runtime-directory ownership

It should not independently maintain:

- provider messages
- a model thread
- a writable public conversation projection
- a “current review” copy separate from the checkpoint
- another context-usage state reconstructed from events and written back

## Request Mapping

SDK Agent request:

```ts
{
  prompt: string;
  conversation?: ConversationState;
  uploads?: ArtifactUpload[];
}
```

Static DAG request:

```ts
{
  graphInput?: JsonObject;
  artifactUploads?: Record<string, ArtifactUpload[]>;
}
```

An HTTP boundary may represent uploads as base64, multipart, or object-storage references, but it
should convert them to `Uint8Array` before Runner. Do not duplicate large binary data in persisted
input JSON.

## Workspace and Private Directories

0.8.3 requires explicit Runner options:

```ts
new Runner({
  provider,
  workspace: hostWorkspace,
  runtimeDirectory: '.runtime',
});
```

`runtimeDirectory` is a safe relative path selected by the host. The 0.8.3 layout is:

```text
<runner workspace>/<runtimeDirectory>/conversations/
<run workspace>/<runtimeDirectory>/results/
<run workspace>/<runtimeDirectory>/history/
```

Remove the obsolete `ResultStoragePolicy.internalDirectory`. The policy now contains only
`maxInlineBytes`.

## Conversation Database Cutover

When migrating to V3:

1. Stop writes and back up database and file resources.
2. Validate `schemaVersion`, id, and revision for every conversation.
3. Preserve directly only documents that are already valid, identity-matched V3.
4. Mark older structures that cannot be converted losslessly as legacy, with export or new-session
   paths.
5. Confirm no reader remains before dropping model-thread/context-usage dual-write columns.
6. Replace whole conversations through revision CAS.

Do not heuristically convert V1/V2 on every request. That makes the same data produce different
history under different application versions.

## Review Resumption

Resume from the complete server checkpoint:

```ts
const decision = reviewDecisionSchema.parse(request.body);
const checkpoint = await atomicallyClaimReview(runId, decision);
await runner.resume(checkpoint, decision);
```

Claim conditions should include run id, `awaiting-review` state, review id, review revision, and an
unconsumed marker. Once claimed, later execution failure must not allow another request to consume
the same checkpoint.

The V4 plan freezes:

- target
- capability ids and definition fingerprints
- effective Skill ids, Agent ids, and Agent-definition fingerprints
- limits, context, result storage, and validation
- workspace and `runtimeDirectory`
- initial `extraSystemPrompt`

Host configuration changes must not alter older resumption semantics. 0.8.3 explicitly rejects V3
checkpoints.

## Events and SSE

- Persist original SDK sequence with a unique `(run_id, sequence)` constraint.
- Persist before broadcasting.
- `Last-Event-ID` returns only greater sequences.
- Renumber a resumed local sequence after existing run events.
- Public projections filter reasoning, while the database may retain complete audit events.

## Reasoning and Sensitive Prompts

At minimum, public APIs remove:

- `AssistantMessage.reasoning`
- reasoning tokens
- internal tool-call details when the UI does not need them
- Agent `systemPrompt`
- plan `extraSystemPrompt`
- validator profile body

Filtering belongs in the response projection. Do not alter the authoritative checkpoint, or
resumption fingerprints and semantics will be damaged.

## Deployment Verification

- Older conversations return an explicit legacy response rather than 500 or silent reset.
- Two concurrent runs cannot write one conversation.
- Only one of two concurrent review decisions is accepted.
- An awaiting-review run remains resumable after host restart.
- SSE reconnection has no duplicate or missing public sequence.
- Large results and attachments restore by checksum in a new process.
- Runner `extraSystemPrompt` or `runtimeDirectory` changes do not affect older checkpoints.
- Provider, Capability, or Agent updates cannot bypass an older approval.
