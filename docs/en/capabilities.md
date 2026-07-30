# Capabilities

Capabilities place tools, MCP, Skills, and other callable actions in one controlled catalog. An
Agent sees only enabled definitions in its scope. Invocation still passes input, output, risk, and
workspace boundaries.

## Capability IDs

Ids include a kind prefix:

- `tool.*`: TypeScript or built-in tools
- `mcp.<server>.<tool>`: MCP tools
- `skill.list` and `skill.view`: Skill accessors

A custom `tool()` id must begin with `tool.`. Ids are part of persisted plans and checkpoint
fingerprints, so do not rename published ids casually.

## Built-in Capabilities

```ts
import { createFileTools, createMemoryTools, createShellTool } from 'dagent-ai';

const capabilities = [
  ...createFileTools(), // read_file / write_file / list_files
  ...createMemoryTools(), // memory_get / memory_set
  createShellTool(),
];
```

File capabilities always work relative to the current `workspacePath`, using normalized and real
paths to prevent symlink escape. Shell is high risk and rejects explicit system-level destructive
commands. Pass a `DockerSandbox` for stronger command isolation.

The default `MemoryStore` belongs to the current process. It is suitable for short-lived Agent
memory, not as a replacement for host SQLite conversation persistence.

## TypeScript Tool

```ts
import { DagentError, Workspace, tool } from 'dagent-ai';
import { z } from 'zod';

const writeReport = tool({
  id: 'tool.write_report',
  name: 'write_report',
  description: 'Write a report in the run workspace.',
  input: z
    .object({
      path: z.string().min(1),
      content: z.string(),
    })
    .strict(),
  output: z.object({ path: z.string(), bytes: z.number().int() }).strict(),
  risk: 'medium',
  boundary: {
    workspaceWrite: true,
    allowedPaths: ['reports'],
  },
  execute: async ({ path, content }, context) => {
    if (
      !path.startsWith('reports/') ||
      path.includes('\\') ||
      path.split('/').some((part) => part === '..' || part === '.')
    ) {
      throw new DagentError('WORKSPACE_VIOLATION', 'Expected a reports/ path.');
    }
    const workspace = await Workspace.open(context.workspacePath);
    await workspace.writeFile(path, content, { overwrite: false });
    return { path, bytes: Buffer.byteLength(content) };
  },
});
```

`ToolOptions<TInput, TOutput>` infers the `execute` parameter and return value from the Zod
schemas. When output is omitted, the result is only guaranteed to be a JSON value. Public
capabilities should normally declare a concrete output schema.

Execution context:

```ts
type CapabilityExecutionContext = {
  readonly runId: RunId;
  readonly workspacePath: string;
  readonly signal: AbortSignal;
  readonly metadata: JsonObject;
};
```

Long-running work should observe `signal`, and file work should remain inside `workspacePath`. The
example also enforces its declared `reports/` sub-boundary. Boundary metadata is auditable
declaration, not a substitute for checks inside the implementation.

## Structured Results

Capability results must be JSON-compatible. When a result exceeds
`resultStorage.maxInlineBytes`, Runner writes it atomically outside conversation JSON and retains a
`ContentReference` in conversation or node state. Downstream DAG nodes restore the value according
to provenance, and checksum mismatch fails.

Tool output must not return functions, class instances, streams, or cyclic objects. Represent file
products with DAG artifacts or the host run-artifact API rather than passing arbitrary absolute
paths across boundaries.

## Catalog and Scope

```ts
runner.registerCapability(writeReport);
runner.catalog.get('tool.write_report');
runner.catalog.definitions();
runner.catalog.replace(updatedBinding);
runner.catalog.unregister('tool.write_report');
```

`register` rejects duplicate ids, while `replace` explicitly overwrites. An Agent capability scope
is an allowlist; unknown or disabled ids fail before planning or execution.

A capability definition includes input/output JSON Schema, risk, boundary, enabled state, and
source. During review resumption, Runner compares frozen definition fingerprints to prevent an
implementation contract from changing after approval.

## MCP Tools

```ts
await runner.connectMcp({
  name: 'filesystem',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', './workspace'],
  includeTools: ['read_file'],
  risk: 'medium',
});
```

HTTP transport:

```ts
await runner.connectMcp({
  name: 'remote',
  transport: 'http',
  url: 'https://example.test/mcp',
  headers: { Authorization: `Bearer ${token}` },
});
```

An MCP tool becomes an ordinary `CapabilityBinding`. `includeTools` and `excludeTools` control
exposure, while the server and tool names form a stable id. If connection discovers an id
collision, Dagent rolls back both registrations and the connection.

```ts
await runner.disconnectMcp('filesystem');
await runner.close(); // also closes remaining MCP connections
```

## TypeScript Capability Modules

A module must list its file and export names explicitly:

```yaml
modules:
  - path: ./capabilities/report-tools.js
    exports:
      - writeReport
```

The SDK loader accepts only verifiable `CapabilityBinding` exports and can constrain files to the
configuration root. The App host also provides discovery, upload, validation, enable/disable, and
persistence APIs. Never load untrusted JavaScript in production. The module itself needs
isolation, not only the shell command it may invoke.

## Direct Testing

A capability is an ordinary typed object and can be tested without starting a model:

```ts
const controller = new AbortController();
await expect(
  writeReport.execute(
    { path: 'reports/a.md', content: 'hello' },
    {
      runId,
      workspacePath,
      signal: controller.signal,
      metadata: {},
    },
  ),
).resolves.toEqual({ path: 'reports/a.md', bytes: 5 });
```

Tests should cover schema rejection, path boundaries, cancellation, output validation, and side
effect idempotency.
