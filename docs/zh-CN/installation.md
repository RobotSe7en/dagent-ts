# 安装

## 环境要求

- Node.js `>= 24`
- ESM 项目（建议在 `package.json` 设置 `"type": "module"`）
- 使用源码工作区时需要 pnpm `10.28` 或兼容的 pnpm 10
- 一个 OpenAI Chat Completions 兼容端点；也可以实现自定义 `ChatProvider`
- 使用 Docker sandbox 时需要可用的 Docker daemon

## 安装 SDK

```bash
pnpm add dagent-ai zod
```

`dagent-ai` 包含 Runner、契约、DAG builder、内置能力、MCP、Skills、Profiles 与
OpenAI-compatible provider，不依赖 Fastify、SQLite 或 React。

```ts
import { Runner } from 'dagent-ai';
import { OpenAICompatibleProvider } from 'dagent-ai/providers/openai-compatible';
```

所有发布入口均为 ESM。不要导入 `dist` 内部路径；可用子路径见
[TypeScript SDK 参考](typescript-sdk.md)。

## 安装本地 Host

`dagent-ai-app` 提供 `dagent` CLI、Fastify API、SQLite 持久化和内嵌 Web 工作台：

```bash
pnpm add -g dagent-ai-app
dagent serve --config ./dagent.yaml
```

默认地址为 `http://127.0.0.1:8000`，默认数据目录是 `~/.dagent-ts`。监听非回环地址前，
应由反向代理补充认证、TLS 和访问控制；Host 本身按本地单用户应用设计。

## 安装 DagentWork 桌面端

```bash
npm install -g dagent-ai-desktop
dagent-desktop
```

轻量 Launcher 会按当前平台可选安装一个原生载荷，支持 macOS、Linux、Windows 的 x64
与 arm64。桌面端是本地 ToolAgent 工作台，不暴露 DagAgent、AutoAgent、静态/已保存 DAG、
DAG Studio、企业连接、账号或 RBAC。其 SQLite 状态与独立任务托管工作区位于 Electron
用户数据目录，不复用 CLI/Web 数据。

## Provider 凭证

默认配置从环境变量读取：

```bash
export OPENAI_API_KEY=...
export OPENAI_BASE_URL=https://api.openai.com/v1
export OPENAI_MODEL=gpt-5-mini
```

`OPENAI_BASE_URL` 和 `OPENAI_MODEL` 会覆盖 App YAML 中的对应字段。自定义密钥变量可通过
`provider.apiKeyEnv` 指定。不要把密钥提交到配置文件或仓库。

## 从源码开发

```bash
git clone https://github.com/RobotSe7en/dagent-ts.git
cd dagent-ts
corepack enable
pnpm install
pnpm verify
```

启动开发 Host：

```bash
export OPENAI_API_KEY=...
pnpm --filter @dagent/web build
pnpm --filter dagent-ai-app build
node packages/app/dist/cli.js serve --config ./examples/dagent.yaml
```

前端独立热更新：

```bash
pnpm --filter @dagent/web dev
```

Vite 开发服务器应代理到运行中的 Host；生产构建会写入 `packages/app/web`，由 Fastify
同源提供。

## 验证安装

```bash
dagent --version
curl http://127.0.0.1:8000/api/v1/health
```

健康检查返回：

```json
{
  "status": "ok",
  "version": "0.9.5"
}
```

若安装或 Provider 调用失败，见 [故障排查](troubleshooting.md)。
