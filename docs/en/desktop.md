# DagentWork Desktop

DagentWork is the local-first desktop surface of Dagent TypeScript. It is intentionally focused on
ToolAgent work: chat with a model, grant a project directory, use local capabilities and Skills,
review risky calls, inspect files, and see the changes observed during a run.

## Install and Run

```bash
npm install -g dagent-ai-desktop
dagent-desktop
```

The launcher selects one optional native package for the current platform. The released matrix is
macOS, Linux, and Windows on x64 and arm64. `dagent-desktop --version` prints the launcher version.

For source development:

```bash
pnpm install
pnpm --filter dagent-ai build
pnpm --filter dagent-ai-app build
pnpm --filter @dagent/desktop-host dev
```

## Product Boundary

Desktop creates a fixed ToolAgent target in the trusted main process. The renderer can select its
capabilities, Skills, and review level, but cannot replace that target. Saved ToolAgents remain
manageable resources; direct desktop tasks do not expose them as callable delegates. Desktop does
not expose DagAgent, AutoAgent, static DAGs, saved DAGs, DAG execution, DAG Studio, enterprise
connections, authentication, accounts, workspaces, RBAC, cloud exchange, or change apply/rollback.

Project tasks run in a directory selected through the native folder dialog. Standalone tasks use a
managed scratch workspace. Conversations record `workspaceScope` as `project` or `standalone`, and
standalone conversations have no `projectId`.

The Changes inspector compares bounded snapshots taken immediately before and after a run. It shows
what was observed; it does not apply, download, export, or roll back changes. Git status and diff
operations are read-only and execute Git directly without a shell.

## Local Resources and Data

The Resources page manages model providers, MCP stdio/HTTP servers, Skills, and ToolAgents. Shell,
filesystem, the SDK runtime, SQLite, and stdio MCP stay local. Network access is limited to the model
endpoint and HTTP MCP endpoints explicitly configured by the user; the renderer itself cannot make
network requests.

Desktop stores its SQLite database, run data, and standalone workspaces below the Electron
`DagentWork Open Source` user-data directory. This location is separate from CLI/Web storage. The
directory is restricted to the current OS user where the platform supports POSIX permissions.

Model API keys and MCP headers/environment secrets are stored as plaintext in this local SQLite
database by design. The UI never returns saved secret values after a write. Protect the OS account,
disk, backups, and user-data directory; delete a resource to remove its active configuration.

## Security Model

- Renderer windows use Chromium sandboxing, context isolation, no Node integration, and a narrow
  preload bridge.
- On Linux, the Launcher uses Chromium's root-owned setuid helper when it is correctly configured;
  otherwise it selects the kernel user-namespace sandbox. Ubuntu hosts that restrict unprivileged
  user namespaces must configure the packaged `chrome-sandbox` file as owner root/mode `4755` or
  install an AppArmor profile that permits user namespaces. The Launcher fails with the exact path
  and never falls back to `--no-sandbox`.
- Every IPC message is strict Zod data, checked again in the main process. Folder and attachment
  paths require short-lived main-process grants from native dialogs.
- Production assets use a contained `app://dagent` protocol and a restrictive Content Security
  Policy. New windows, navigation, webviews, permissions, and renderer-originated requests are
  denied.
- Electron fuses disable `RunAsNode`, `NODE_OPTIONS`, and inspector CLI arguments, require ASAR
  integrity, and load only from ASAR. Only one desktop instance owns the database.
- Capability risk policy and declared allowed-path boundaries remain authoritative. Approving a
  boundary exception reuses only the specifically approved paths for the same resumable run.

These controls reduce accidental exposure; they do not turn arbitrary local shell commands or
third-party MCP servers into a security sandbox. Review their configuration and keep review level
`risky` or `always` for untrusted tasks.
