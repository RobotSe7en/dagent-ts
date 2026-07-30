# API Host Persistence

`dagent-ai-app` is the unified host for local single-user workflows. It stores projects,
conversations, runs, DAGs, and configuration in SQLite and keeps project files and private runtime
data below `dataDirectory`.

## Local Project Mode

The host creates:

```text
<dataDirectory>/
├── dagent.sqlite3
├── workspace/
├── skills/
├── profiles/
├── capability-modules/
└── ...
```

The database file is set to mode `0600`. SQLite enables WAL, foreign keys, and a five-second busy
timeout. Keep `dataDirectory` on trusted local storage; do not place an active SQLite database
directly on a network-synchronized drive.

## Single-writer Lease

Every host process acquires the `app-writer` lease at startup, with a default 15-second TTL and
periodic renewal. A second process refuses to start while the database has a valid lease.

This is local process coordination, not distributed leader election. Horizontal scaling requires
replacing the database and lease implementations rather than sharing SQLite between processes.

## Storage Model

Primary tables:

| Table                    | Contents                                                 |
| ------------------------ | -------------------------------------------------------- |
| `projects`               | project metadata and root path                           |
| `conversations`          | complete V3 ConversationState, kind, and revision        |
| `runs`                   | target, redacted input, status, and latest V4 checkpoint |
| `run_events`             | complete event log unique by `(run_id, sequence)`        |
| `saved_dags`             | canonical graph, canvas layout, revision, archive state  |
| `orchestration_sessions` | conversation, draft graph, and UI-state association      |
| `agents`                 | managed Agent presets                                    |
| `model_providers`        | provider configuration and active marker                 |
| `mcp_servers`            | persisted MCP server configuration                       |
| `capability_modules`     | module source, path, exports, and enabled state          |
| `template_capabilities`  | UI-created capability templates                          |
| `settings`               | validation and application settings                      |
| `leases`                 | single-writer leases                                     |

Binary uploads are not copied verbatim into `runs.input_json`; the host stores filename and byte
length only. Content belongs to the SDK conversation resource store or project/artifact files.

## Conversation Persistence

Only an identity-matched V3 `ConversationState` is authoritative:

- JSON `schemaVersion === 3`
- JSON `id` equals the database conversation id
- JSON `revision` aligns with the database revision

Whole-document updates use revision CAS. Migration 009 marks older V1/V2 or damaged structures as
schema version 0. Reading their complete state or continuing them returns a conflict instead of
guessing a conversion in the request path.

## Runs and Events

New-run event flow:

```text
Runner event
  → INSERT run_events
  → persist checkpoint/conversation when present
  → publish to in-process SSE listeners
```

A unique constraint prevents duplicate sequences in one run. `event-log?after=N` and SSE
`Last-Event-ID: N` both read later events from the database.

While review is pending, the run stores the complete server checkpoint. The public API returns a
trimmed projection. Resumption uses the database object rather than a checkpoint returned by the
client.

## Restart Recovery

At startup, the host runs `RunRecoveryService`:

- active states left by the previous process become explicit interrupted/failed states
- a persisted `awaiting-review` checkpoint remains resumable in the new process
- SSE clients can continue from existing sequences
- active provider requests and in-process cancellation controllers cannot survive a restart

Dagent provides recovery at persistent boundaries. It does not pretend to restore a lost network
stream or an arbitrary JavaScript stack.

## Saved DAGs and Orchestration

A saved DAG stores canonical graph and independent layout. Graph participates in validation and
execution; layout belongs to UI only. Revision checks prevent two editors from overwriting each
other.

An orchestration session associates a DAG edit/run workflow with a conversation, project, and
optional saved DAG. A run may record `savedDagId` and `orchestrationSessionId` for history queries,
but Runner itself does not depend on host ids.

## Backup

A safe backup:

1. Stop the host and ensure the writer lease is released.
2. Copy the entire `dataDirectory`, including SQLite, any remaining WAL, and file directories.
3. Start the copy from an isolated path and verify migration and `/api/v1/health`.

Copying only `dagent.sqlite3` can lose WAL data or external resources. Read
[Migration Notes](migration.md) before restoring into an older binary. Database migrations do not
promise reversible downgrade.

## Enterprise Path

Turning the local host into a multi-user service additionally requires:

- authentication, authorization, and tenant isolation
- secret management and audit logs
- a shared database such as PostgreSQL and a distributed lease
- object storage and leased artifact lifecycles
- worker queues, idempotent jobs, and run ownership
- API rate limits, CSRF/CORS protection, and network boundaries

None of these are promises of the current local host.
