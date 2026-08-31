# Installation

## Requirements

- Node.js `>= 24`
- An ESM project; setting `"type": "module"` in `package.json` is recommended
- pnpm `10.28` or a compatible pnpm 10 release when working from the source workspace
- An OpenAI Chat Completions compatible endpoint, or a custom `ChatProvider`
- A working Docker daemon when using the Docker sandbox

## Install the SDK

```bash
pnpm add dagent-ai zod
```

`dagent-ai` includes Runner, contracts, the DAG builder, built-in capabilities, MCP, Skills,
profiles, and the OpenAI-compatible provider. It does not depend on Fastify, SQLite, or React.

```ts
import { Runner } from 'dagent-ai';
import { OpenAICompatibleProvider } from 'dagent-ai/providers/openai-compatible';
```

All published entry points are ESM. Do not import internal `dist` paths. See the
[TypeScript SDK Reference](typescript-sdk.md) for supported package subpaths.

## Install the Local Host

`dagent-ai-app` provides the `dagent` CLI, Fastify API, SQLite persistence, and embedded Web
workbench:

```bash
pnpm add -g dagent-ai-app
dagent serve --config ./dagent.yaml
```

The default URL is `http://127.0.0.1:8000`, and the default data directory is `~/.dagent-ts`.
Before binding to a non-loopback address, put authentication, TLS, and access control in a reverse
proxy. The host itself is designed as a local single-user application.

## Install DagentWork Desktop

```bash
npm install -g dagent-ai-desktop
dagent-desktop
```

The small launcher depends optionally on exactly one native payload for the current platform:
macOS, Linux, or Windows on x64 or arm64. Desktop is a local ToolAgent workbench; it does not expose
DagAgent, AutoAgent, static/saved DAGs, DAG Studio, enterprise connections, accounts, or RBAC.
Its SQLite state and managed standalone-task workspaces live under the Electron user-data directory
and do not reuse CLI/Web data.

## Provider Credentials

The default configuration reads environment variables:

```bash
export OPENAI_API_KEY=...
export OPENAI_BASE_URL=https://api.openai.com/v1
export OPENAI_MODEL=gpt-5-mini
```

`OPENAI_BASE_URL` and `OPENAI_MODEL` override their App YAML values. Set
`provider.apiKeyEnv` to use a different credential variable. Never commit credentials to a
configuration file or repository.

## Develop from Source

```bash
git clone https://github.com/RobotSe7en/dagent-ts.git
cd dagent-ts
corepack enable
pnpm install
pnpm verify
```

Start the development host:

```bash
export OPENAI_API_KEY=...
pnpm --filter @dagent/web build
pnpm --filter dagent-ai-app build
node packages/app/dist/cli.js serve --config ./examples/dagent.yaml
```

Run the frontend with hot reload:

```bash
pnpm --filter @dagent/web dev
```

Configure the Vite development server to proxy to the running host. Production builds are written
to `packages/app/web` and served by Fastify from the same origin.

## Verify the Installation

```bash
dagent --version
curl http://127.0.0.1:8000/api/v1/health
```

The health endpoint returns:

```json
{
  "status": "ok",
  "version": "0.9.5"
}
```

See [Troubleshooting](troubleshooting.md) if installation or provider calls fail.
