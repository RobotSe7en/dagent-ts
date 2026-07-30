# dagent-ai

Type-safe Agent and DAG runtime for Node.js 24+.

```bash
pnpm add dagent-ai zod
```

```ts
import { Runner, defineToolAgent, tool } from 'dagent-ai';
import { OpenAICompatibleProvider } from 'dagent-ai/providers/openai-compatible';
```

The package contains immutable agent contracts, typed capabilities, canonical dynamic and static
DAG execution, MCP, Skills, review checkpoints, bounded conversations, result externalization,
profiles, and an optional Docker command sandbox. It has no Fastify, SQLite, or React dependency.

Public subpaths:

- `dagent-ai/contracts`
- `dagent-ai/config`
- `dagent-ai/capabilities`
- `dagent-ai/mcp`
- `dagent-ai/modules`
- `dagent-ai/sandbox`
- `dagent-ai/skills`
- `dagent-ai/profiles`
- `dagent-ai/providers/openai-compatible`
- `dagent-ai/testing`

See the repository
[README](https://github.com/RobotSe7en/dagent-ts#readme),
[quick start](https://github.com/RobotSe7en/dagent-ts/blob/main/docs/quick-start.md), and
[TypeScript SDK reference](https://github.com/RobotSe7en/dagent-ts/blob/main/docs/typescript-sdk.md).

License: Apache-2.0.
