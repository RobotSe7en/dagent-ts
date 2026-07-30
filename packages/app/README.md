# dagent-ai-app

Local Fastify API, SQLite persistence, CLI, and embedded React workbench for
`dagent-ai`.

```bash
pnpm add -g dagent-ai-app
dagent serve --config ./dagent.yaml
```

```text
Usage: dagent serve [--config path] [--host address] [--port number]
```

The server binds to `127.0.0.1:8000` by default and stores local data under
`~/.dagent-ts`. It manages projects, conversations, runs, saved DAGs, agents, model providers, MCP,
TypeScript capability modules, Skills, profiles, validation, artifacts, and optional OnlyOffice
integration.

This host is designed as a local single-user application. Add authentication, TLS, authorization,
and tenant isolation before exposing it to a network.

See
[installation](https://github.com/RobotSe7en/dagent-ts/blob/main/docs/installation.md),
[Runner and configuration](https://github.com/RobotSe7en/dagent-ts/blob/main/docs/runner-and-configuration.md),
[persistence](https://github.com/RobotSe7en/dagent-ts/blob/main/docs/api-backend-persistence.md),
and [HTTP API](https://github.com/RobotSe7en/dagent-ts/blob/main/docs/http-api.md).

License: Apache-2.0.
