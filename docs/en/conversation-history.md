# Conversation History and Context

The 0.8 line uses the V3 conversation design. It does not reduce chat history to provider messages
or maintain two conversation states.

## One Authoritative Document, Two Projections

V3 persists one complete, bounded `ConversationState`. It contains user messages, assistant
answers, tool results, and internal planner or validator audit items. `scope` and `visibility`
determine use:

- ContextAssembler builds provider input from the document but never replays reasoning.
- HTTP returns a separate `PublicConversationState` projection that retains only
  `visibility=user` items and removes assistant reasoning, tool calls, and compactor reasoning.
- `ContextUsage` is stored as checkpoint/event audit rather than a second conversation history.

Conversation items form a discriminated union:

- `UserMessage`
- `AssistantMessage`
- `ToolResultMessage`

Provider adaptation happens at the final step, keeping OpenAI-compatible fields out of the
persistent model.

## Reasoning Records

`AssistantMessage.reasoning` may store a provider reasoning field or captured think-tag content.
It is internal audit data. ContextAssembler never projects it into a later model request, and the
public HTTP projection never returns it, preventing recursive amplification or accidental
exposure.

Web may display compacted early context, but it consumes the public summary type rather than the
internal `ContextSummary`.

## Context Compaction

Defaults:

- trigger at 80% of the context window
- keep the latest four turns
- 1,024-token summary budget
- at most 2,048 tokens per tool result
- at most 8,192 tool-result tokens in total
- 15% safety margin

The preferred model summary retains requirements, constraints, facts, failures, and unfinished
work. If model compaction fails, Dagent uses a deterministic fallback and records it in
`ContextUsage.compactionMethod`. Both compaction input and output remain strictly budgeted.

Large tool results are written atomically into the run directory. History retains a typed relative
path, byte count, SHA-256, and preview. Only values with `valueReference` provenance are restored;
ordinary user JSON is never mistaken for a reference. Attachments and conversation references
enter a content-addressed store and can be rebuilt in the next run workspace.

## Checkpoint and Host Persistence

A V5 review checkpoint stores the complete V3 `conversation`, frozen capability-definition
fingerprints, execution limits, runtime directory, initial additional system prompt, and
`contextUsage`. The host atomically claims a checkpoint once and uses revision compare-and-swap for
whole-conversation replacement. Duplicate review, changed definitions, or stale conversation
revisions fail before execution.

Database migration does not guess V1/V2 structures at request time. A document that is not a valid,
identity-matched V3 conversation is marked `legacy`, and details or continuation return HTTP 409.

## Revision and Concurrency

`ConversationState.revision` increases with every authoritative change. The host saves the whole
document through revision compare-and-swap. If exactly one row is not updated, the run fails with a
concurrency conflict rather than overwriting another request's history.

One conversation can have only one active or review-pending run. A new request returns
`CONCURRENCY_CONFLICT`. If a resumed dynamic DAG fails, re-plans, and reaches another review, its
revision also advances. The second checkpoint cannot masquerade as the state of the first review.

## Attachment and Reference Lifecycle

Uploads first enter the content-addressed conversation store:

```text
<runner workspace>/<runtimeDirectory>/conversations/
```

Model context receives only bounded attachment descriptions and content references. When execution
uses another `workspacePath`, runtime rebuilds required resources by checksum. Later turns restore
only explicit provenance; user JSON with a similar shape is not treated as a file or externalized
result.

Large run values live under:

```text
<run workspace>/<runtimeDirectory>/results/
```

History required for resumption lives under:

```text
<run workspace>/<runtimeDirectory>/history/
```

V5 checkpoints freeze `runtimeDirectory`, so a Runner configuration change cannot make an older
run read the wrong resource directory.

## Public Host Projection

Public run and conversation responses also remove:

- target `systemPrompt`
- plan `extraSystemPrompt`
- validator profile body
- reasoning token events

The authoritative server checkpoint still retains values required for resumption; they are simply
not part of the browser API. Public trace is computed from persisted events and the checkpoint,
not maintained as another writable state.

## Integration Rules

- An SDK host must persist the complete V3 `ConversationState` without trimming it.
- Never write the public conversation projection back as authoritative history.
- Never hand-build item ids, run ids, or revisions.
- Save checkpoints and conversations in a transaction boundary that can detect concurrency.
- A host may retain less reasoning, but must never use reasoning as next-turn model input.

Related pages:
[Conversations, Results, Streaming, and Review](results-streaming-review.md) and
[0.8 Host Migration](host-migration-0.8.md).
