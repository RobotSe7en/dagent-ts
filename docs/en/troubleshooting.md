# Troubleshooting

## Import Fails after Installation

Confirm Node.js 24, ESM, and a public subpath:

```bash
node --version
node -e "import('dagent-ai').then(m => console.log(typeof m.Runner))"
```

Do not import `dagent-ai/dist/...`. Run `pnpm build` in the source workspace. Restart the
TypeScript server if the editor cached older `.d.ts` files.

## Provider Authentication Fails

Check the actual environment:

```bash
test -n "$OPENAI_API_KEY" && echo configured
```

Host `provider.apiKeyEnv` must name the correct variable. `OPENAI_BASE_URL` and `OPENAI_MODEL`
override YAML. Some compatible endpoints do not support streamed usage, reasoning fields, or
specific top-level parameters. Remove `streamIncludeUsage`, `reasoning`, `extraRequestArgs`, and
`extraBody`, then enable them one at a time.

## Structured Output or Tool Arguments Fail

0.8 never silently rewrites invalid JSON or non-object tool arguments to `{}`. The error usually
means:

- the model or endpoint lacks required tool calling
- the schema is too complex
- the provider returned prose around non-JSON content
- capability output does not match its declared Zod schema

Redact credentials and sensitive prompts from retained provider logs.

## Configuration File Missing or Fields Rejected

SDK `createRunnerFromConfigFile()` and App `dagent serve --config` use different schemas. App fields
include `skillRoots` and `capabilityModules`; SDK Runner YAML uses nested `skills` and `modules`.

SDK module, Skill, profile, and stdio MCP cwd paths resolve from the Runner configuration directory.
App resolves `skillRoots`, profiles, capability modules, and sandbox Skill directories relative to
its configuration file; relative `dataDirectory` and App MCP cwd values resolve from host process
cwd.

## A Second Host Cannot Start

When the database is owned by another process, check for an existing `dagent-ai-app` using the same
`dataDirectory`. Do not delete a valid lease or run two writers. After the original process exits,
the lease is removed or expires after its TTL.

## MCP Registration Fails

Check:

- the stdio command is executable in the host environment
- `cwd` exists
- HTTP URL and headers are correct
- the server name is unique
- include/exclude tool names match
- generated MCP capability ids do not collide with the catalog

If a connection collides, Dagent rolls back registered capabilities and disconnects the server.

## Unknown Capability

Existence does not imply Agent visibility. Check in order:

1. `runner.catalog.get(id)`
2. definition `enabled`
3. Agent `scope.capabilities`
4. MCP/module connection and enabled state
5. exact id prefix

Dynamic DAG scope is validated before execution; model output cannot bypass an allowlist.

## Agent Cannot See a Skill

Confirm that the Skill root exists, directory depth is supported, `SKILL.md` is readable, and the
Agent has both:

- `skill.list` / `skill.view` in `scope.capabilities`
- the Skill name or qualified name in `scope.skills`

A short name duplicated across categories is ambiguous; use `category/name`.

## Static DAG Validation Fails

Common causes:

- duplicate node or artifact id
- a cycle or edge to an unknown node
- `ValueRef` to a non-upstream node
- wrong map/loop `executionScope`
- `item()` in a root graph
- `iteration()` outside a loop graph
- undeclared artifact or mismatched node boundary
- loop `maxIterations` above 100

Use `validateDag()` to show all issues in an editor and `assertValidDag()` at a server execution
boundary.

## Context Window Exceeded

First confirm accurate provider `contextWindowTokens` and `outputReserveTokens`. Then reduce Agent
tool scope, shorten system prompts, reduce tool-schema size, or adjust context policy.

Do not claim a larger model window than exists; that only moves the failure to the provider.
Compaction cannot help when required system prompts and schemas already exceed the budget.

## Review Resumption Fails

- `STALE_REVIEW`: id/revision mismatch or already consumed
- `CHECKPOINT_MISMATCH`: changed checkpoint, capability definition, target, or resource
- `CONCURRENCY_CONFLICT`: another request advanced the conversation revision
- older V3 checkpoint: 0.8.3 accepts only V4

A host client submits only a decision. It must not cache and return a trimmed public checkpoint.

## SSE Text Is Missing or Duplicated

Store the last successfully processed SSE `id` as sequence and send it as `Last-Event-ID` on
reconnection. Do not treat JSON event log and SSE as two independent new-message streams; both use
the same sequence for deduplication.

Reasoning tokens are deliberately absent from the public API, so public and internal SDK streams
can have different token counts.

## File or Externalized Result Cannot Restore

Check the original run `workspacePath`, V4 plan `runtimeDirectory`, file permissions, and checksum.
Do not move one `results` file without migrating the whole run directory. Symlink escape and
checksum change are rejected as safety errors.

## Docker Sandbox Unavailable

```bash
docker info
curl http://127.0.0.1:8000/api/v1/sandbox/status
```

Confirm image availability, daemon permissions, and workspace bind mounts. The sandbox defaults to
no network. Enable it explicitly only when required, after evaluating capability risk and host
environment boundaries.
