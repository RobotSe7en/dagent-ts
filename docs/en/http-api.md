# HTTP API

All unified-host application endpoints live under `/api/v1`. The host binds only to `127.0.0.1` by
default and provides no built-in multi-user authentication.

## Protocol Conventions

- Requests and ordinary responses use `application/json`.
- Resource creation usually returns `201`, asynchronous start/resume returns `202`, and successful
  deletion returns `204`.
- Timestamps are offset-aware ISO 8601 strings.
- Resource ids are opaque strings; do not infer behavior from prefixes.
- Zod strict schemas reject unknown fields on primary write endpoints.

Error:

```json
{
  "error": {
    "code": "INVALID_INPUT",
    "message": "...",
    "issues": []
  }
}
```

`issues` appears only for schema validation errors. Common statuses:

- `400`: invalid input, DAG, capability, or checkpoint contract
- `404`: missing resource or capability
- `409`: revision conflict, legacy conversation, active run, or stale review
- `500`: unclassified host error

## Health

```http
GET /api/v1/health
```

```json
{ "status": "ok", "version": "0.8.3" }
```

## Projects and Files

| Methods                             | Path                           | Purpose                                      |
| ----------------------------------- | ------------------------------ | -------------------------------------------- |
| `GET` / `POST`                      | `/projects`                    | list or create projects                      |
| `GET` / `PATCH` / `DELETE`          | `/projects/:id`                | read, update, or delete a project            |
| `GET` / `POST` / `PATCH` / `DELETE` | `/projects/:id/files`          | browse, upload, move/rename, or delete files |
| `POST`                              | `/projects/:id/directories`    | create a directory                           |
| `GET`                               | `/projects/:id/files/download` | download a file                              |

Every path is relative to the project root and passes boundary and symlink checks.

## Conversations

| Methods                    | Path                                                 | Purpose                         |
| -------------------------- | ---------------------------------------------------- | ------------------------------- |
| `GET` / `POST`             | `/conversations`                                     | global query or creation        |
| `GET` / `PATCH` / `DELETE` | `/conversations/:id`                                 | details, title update, deletion |
| `GET`                      | `/conversations/:id/messages`                        | user-visible message projection |
| `GET`                      | `/conversations/:id/runs`                            | runs for a conversation         |
| `GET` / `POST`             | `/projects/:id/conversations`                        | project-scoped conversations    |
| `GET` / `PATCH` / `DELETE` | `/projects/:projectId/conversations/:conversationId` | project-scoped details          |

Create:

```json
{
  "projectId": "project_...",
  "title": "Release review",
  "kind": "chat"
}
```

`kind` is `chat`, `dynamic-dag`, or `static-dag`. Conversation details contain a public V3
projection with reasoning, tool calls, internal items, and sensitive system prompts removed.

## Start a Run

```http
POST /api/v1/runs
```

Agent:

```json
{
  "conversationId": "conversation_...",
  "target": {
    "kind": "tool-agent",
    "id": "assistant",
    "name": "Assistant",
    "scope": {
      "capabilities": ["tool.read_file"],
      "skills": [],
      "agents": []
    },
    "reviewLevel": "risky"
  },
  "input": {
    "prompt": "Read the attached specification.",
    "uploads": [
      {
        "filename": "spec.md",
        "contentBase64": "IyBTcGVjaWZpY2F0aW9u"
      }
    ]
  }
}
```

Static DAG:

```json
{
  "target": {
    "kind": "static-dag",
    "graph": {
      "schemaVersion": 1,
      "id": "example",
      "name": "Example",
      "nodes": [],
      "edges": [],
      "artifacts": {}
    },
    "reviewLevel": "never"
  },
  "input": {
    "graphInput": {},
    "artifactUploads": {}
  }
}
```

An Agent run accepts at most 32 attachments, each with valid base64 content. Response:

```json
{ "runId": "run_..." }
```

The status is `202`. The caller then reads the run, JSON event log, or SSE stream.

## Run Resources

| Methods          | Path                           | Purpose                                                      |
| ---------------- | ------------------------------ | ------------------------------------------------------------ |
| `GET`            | `/runs`                        | filter by project, conversation, saved DAG, or orchestration |
| `GET` / `DELETE` | `/runs/:id`                    | details or deletion of a finished run                        |
| `POST`           | `/runs/:id/cancel`             | request cancellation of an active run                        |
| `POST`           | `/runs/:id/reviews`            | resume a review-pending run                                  |
| `GET`            | `/runs/:id/event-log?after=N`  | JSON event log                                               |
| `GET`            | `/runs/:id/trace`              | public trace, usage, and events                              |
| `GET`            | `/runs/:id/events`             | resumable SSE                                                |
| `GET`            | `/runs/:id/artifacts`          | list run artifacts                                           |
| `GET`            | `/runs/:id/artifacts/preview`  | safe preview                                                 |
| `GET`            | `/runs/:id/artifacts/download` | download an artifact                                         |

An active run cannot be deleted. Reasoning tokens do not appear in the public event log, trace, or
SSE stream.

## SSE

```http
GET /api/v1/runs/run_123/events
Accept: text/event-stream
Last-Event-ID: 17
```

Event:

```text
id: 18
event: node-completed
data: {"runId":"run_123","sequence":18,...}
```

The host sends a comment heartbeat every 15 seconds. Events are persisted before broadcast. A new
connection subscribes to live events before reading database history and deduplicates by sequence,
so the transition does not lose an event.

## Review

```http
POST /api/v1/runs/:id/reviews
```

```json
{
  "reviewId": "review_...",
  "revision": 0,
  "action": "approve",
  "reason": "Approved by operator."
}
```

The host reads the complete checkpoint from the database and atomically claims the review. The
client does not upload a checkpoint. Duplicate, stale, or mismatched decisions return `409`.

## DAG and Orchestration

| Methods                    | Path                               | Purpose                                  |
| -------------------------- | ---------------------------------- | ---------------------------------------- |
| `POST`                     | `/dags/validate`                   | validate canonical DAGSpec               |
| `GET` / `POST`             | `/saved-dags`                      | query or create saved graphs             |
| `GET` / `PATCH` / `DELETE` | `/saved-dags/:id`                  | details, revision update, archive/delete |
| `GET` / `POST`             | `/saved-dags/:id/runs`             | run history and start                    |
| `POST`                     | `/orchestration-sessions`          | create an orchestration session          |
| `GET` / `PATCH`            | `/orchestration-sessions/:id`      | details and revision update              |
| `GET`                      | `/orchestration-sessions/:id/runs` | orchestration runs                       |

A saved DAG stores graph and layout separately. Only graph enters Runner.

## Configuration Resources

| Resource             | Path                                 | Operations                                       |
| -------------------- | ------------------------------------ | ------------------------------------------------ |
| Agent presets        | `/agents`, `/agents/:id`             | list/create/get/update/delete                    |
| Providers            | `/models`, `/models/:id`             | CRUD and `/:id/activate`                         |
| MCP                  | `/mcp/servers`, `/mcp/servers/:name` | CRUD and `/mcp/reload`                           |
| Capability catalog   | `/capabilities`, `/capabilities/:id` | query, enable/disable, direct test               |
| Capability templates | `/capabilities/templates`            | CRUD                                             |
| TypeScript modules   | `/capability-modules`                | discover, validate, upload, source, reload, CRUD |
| Profiles             | `/profiles`, `/profiles/:name`       | managed profile CRUD                             |
| Skills               | `/skills`, `/skills/view`            | list/view/install/delete                         |
| Validation           | `/settings/validation`               | get/update                                       |
| Sandbox              | `/sandbox/status`                    | Docker availability and policy                   |

Credentials, Agent system prompts, host `extraSystemPrompt`, and validator profile bodies are not
returned in public run projections.

## OnlyOffice

The host includes optional local document-integration routes:

- `/system/onlyoffice`
- `/projects/:id/files/onlyoffice/config`
- `/runs/:id/artifacts/onlyoffice/config`
- `/onlyoffice/files/:token`
- `/onlyoffice/callback/:token`

Without configuration, they do not affect ordinary file or artifact APIs. A token grants temporary
file access; it does not replace the authentication required when exposing the host publicly.
