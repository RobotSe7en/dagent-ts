# DagentWork 桌面端

DagentWork 是 Dagent TypeScript 的本地优先桌面界面，专注 ToolAgent 工作流：与模型对话、
授权项目目录、使用本地能力与 Skills、审核风险调用、浏览文件，以及查看运行期间实际
观察到的变化。

## 安装与启动

```bash
npm install -g dagent-ai-desktop
dagent-desktop
```

Launcher 会按当前平台选择一个可选原生包。发布矩阵覆盖 macOS、Linux、Windows 的 x64
和 arm64；`dagent-desktop --version` 输出 Launcher 版本。

从源码开发：

```bash
pnpm install
pnpm --filter dagent-ai build
pnpm --filter dagent-ai-app build
pnpm --filter @dagent/desktop-host dev
```

## 产品边界

桌面端在可信 Main Process 中构造固定的 ToolAgent target。Renderer 可以选择 capabilities、
Skills、嵌套 ToolAgents 和 review level，但不能替换 target。桌面端不暴露 DagAgent、
AutoAgent、静态 DAG、已保存 DAG、DAG 执行、DAG Studio、企业连接、认证、账号、工作区、
RBAC、云交换或变更 apply/rollback。

项目任务在原生目录对话框授权的目录中运行；独立任务使用托管的临时工作区。会话以
`workspaceScope` 区分 `project` 与 `standalone`，独立会话没有 `projectId`。

Changes Inspector 比较运行前后立即采集的有界快照，只展示观察到的变化，不负责 apply、
下载、导出或 rollback。Git status/diff 是不经过 shell 的只读操作。

## 本地资源与数据

Resources 页面管理模型 Provider、MCP stdio/HTTP server、Skills 与 ToolAgents。Shell、
文件系统、SDK runtime、SQLite 和 stdio MCP 都留在本机；网络只用于用户明确配置的模型
端点与 HTTP MCP 端点，Renderer 自身不能发起网络请求。

桌面 SQLite、运行数据与独立任务工作区位于 Electron 的 `DagentWork Open Source` 用户
数据目录，与 CLI/Web 存储完全隔离。在支持 POSIX 权限的平台上，目录只允许当前 OS
用户访问。

按产品选择，模型 API key 以及 MCP header/env secret 以明文保存在本地 SQLite 中。
写入后 UI 不会返回已保存的 secret 值。请保护 OS 账号、磁盘、备份和用户数据目录；
删除对应资源会移除其活动配置。

## 安全模型

- Renderer 使用 Chromium sandbox、context isolation、关闭 Node integration，并只暴露窄化
  的 Preload bridge。
- Linux Launcher 会优先使用配置正确、root-owned 的 Chromium setuid helper，否则选择内核
  user-namespace sandbox。限制 unprivileged user namespace 的 Ubuntu 主机必须把随包的
  `chrome-sandbox` 配置为 root owner/`4755` mode，或安装允许 user namespace 的 AppArmor
  profile。Launcher 会给出准确路径并安全失败，绝不回退到 `--no-sandbox`。
- 每条 IPC 消息都是严格 Zod 数据，并在 Main Process 重新校验。文件夹和附件路径必须
  来自原生对话框生成的短期 Main Process grant。
- 生产资源通过受约束的 `app://dagent` 协议与严格 CSP 加载；新窗口、导航、WebView、
  权限和 Renderer 发起的请求全部拒绝。
- Electron fuses 禁用 `RunAsNode`、`NODE_OPTIONS` 和 Inspector CLI 参数，启用 ASAR
  完整性并只允许从 ASAR 加载；同一时间只有一个桌面实例拥有数据库。
- Capability 风险策略和声明的 allowed-path 边界保持权威。同一次可恢复运行中，边界例外
  只复用明确审核通过的具体路径。

这些控制用于减少意外暴露，并不会把任意本地 shell 命令或第三方 MCP server 变成安全
sandbox。对不可信任务应审查资源配置，并保持 `risky` 或 `always` 审核级别。
