# Conversations, Results, Streaming, and Review

## Continue a Multi-turn Conversation

```ts
const first = await runner.run(agent, { prompt: 'Inspect the project.' });

const second = await runner.run(agent, {
  prompt: 'Now summarize the risky changes.',
  conversation: first.state.conversation,
});
```

Each new run receives a new `runId` but can continue the same `ConversationState` identity and
revision. The host loads the full V3 document by conversation id and saves it through revision
compare-and-swap.

## What Actually Reaches the Model

Every conversation item has scope and visibility. `ContextAssembler` projects provider messages
for the role making the current call:

- visible user and assistant text enters context in order
- tool results are truncated by per-item and total budgets
- reasoning is never replayed
- router, planner, validator, subagent, and compactor receive only their required projections
- content, value, and artifact references are deduplicated and globally bounded

The public HTTP conversation is another read-only projection. It retains only
`visibility=user` content and removes assistant reasoning, tool calls, and internal compaction
details. It is not a full `ConversationState` that can be sent back to the SDK.

## Context Limits and Compaction

Default policy:

| Field                      | Default |
| -------------------------- | ------: |
| `compactionTriggerRatio`   |   `0.8` |
| `keepRecentTurns`          |     `4` |
| `summaryMaxTokens`         |  `1024` |
| `maxToolResultTokens`      |  `2048` |
| `maxTotalToolResultTokens` |  `8192` |
| `tokenSafetyMargin`        |  `0.15` |

At the trigger, Runner keeps recent turns and creates a bounded summary of older content. If model
compaction fails, it uses a deterministic fallback and records the method in
`ContextUsage.compactionMethod`.

If system prompts, tool schemas, and required context already exceed the budget, Runner throws
`ContextWindowExceededError`. It does not silently remove safety instructions or invent token
capacity.

## Provider Usage and Reasoning

A `token` event has channel `content` or `reasoning`. Reasoning may be retained in an internal
`AssistantMessage` for audit, but it is neither returned by the public conversation API nor placed
in later model context.

Provider usage enters run audit. Not every OpenAI-compatible endpoint supports streamed usage; set
`streamIncludeUsage: true` only after confirming endpoint compatibility.

## Large Results

`resultStorage.maxInlineBytes` defaults to 256 KiB. JSON results above the threshold are written to:

```text
<run workspace>/<runtimeDirectory>/results/
```

A historical `ContentReference` stores relative path, MIME type, byte count, SHA-256, and preview.
Downstream nodes, maps, loops, and resumption restore values only with explicit provenance. Missing
files, changed checksums, or references escaping the runtime directory fail.

Private directories are created lazily. A run with no attachments, large results, or restored
history leaves no empty directory tree.

## Streaming Events

```ts
for await (const event of runner.stream(target, input, { signal })) {
  switch (event.type) {
    case 'run-started':
    case 'token':
    case 'plan-proposed':
    case 'review-required':
    case 'node-started':
    case 'node-completed':
    case 'capability-started':
    case 'capability-completed':
    case 'checkpoint':
    case 'context-compaction-started':
    case 'context-compaction-finished':
    case 'context-usage':
    case 'validation-started':
    case 'validation-finished':
    case 'run-completed':
      break;
  }
}
```

`RunEvent` is a complete discriminated union. Every event has a run id, a sequence beginning at 1,
and an offset-aware timestamp. An SDK stream ends naturally after completion and throws from
iteration on error.

The host writes events to SQLite before broadcasting SSE. A client resuming with SSE `id` or
`Last-Event-ID` receives only greater sequences and does not depend on process memory.

## Review and Resumption

```ts
const outcome = await runner.run(target, input);

if (outcome.status === 'awaiting-review') {
  const resumed = await runner.resume(outcome.checkpoint, {
    reviewId: outcome.review.id,
    revision: outcome.review.revision,
    action: 'approve',
    reason: 'Reviewed by operator.',
  });
}
```

Reject:

```ts
await runner.resume(checkpoint, {
  reviewId: review.id,
  revision: review.revision,
  action: 'reject',
  reason: 'The requested path is outside policy.',
});
```

A DAG review can also include a validated `replacementGraph`.

Before resumption, Runner validates:

- checkpoint schema version and fingerprint
- review id and revision
- capability-definition fingerprints and scope
- frozen execution limits and consumed usage
- runtime directory, workspace continuation resources, and conversation revision
- whether the same review has already been consumed

The SDK rejects a duplicate decision in the process. The host additionally uses an atomic database
claim to prevent concurrent or post-restart duplicate consumption. If a reviewed dynamic DAG
fails and re-plans into another review boundary, the authoritative conversation revision advances.

## Cancellation

Pass an `AbortSignal`:

```ts
const controller = new AbortController();
const promise = runner.run(target, input, { signal: controller.signal });
controller.abort();
```

Or cancel by a run id from an event:

```ts
runner.cancel(runId, 'Cancelled by user.');
```

Capability implementations and provider adapters should observe the signal. Cancellation is a
normal `RunOutcome` status and should not be rewritten by a host as a generic 500 response.
