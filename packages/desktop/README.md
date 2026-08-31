# DagentWork Desktop

`dagent-ai-desktop` is the small cross-platform launcher for the open-source, local-first
DagentWork desktop application. Installation selects an optional prebuilt package for the current
operating system and CPU architecture.

```bash
npm install --global dagent-ai-desktop
dagent-desktop
```

Supported targets: Windows, macOS, and Linux on x64 and arm64. Desktop state is isolated from the
`dagent` CLI/Web application. Model keys and MCP secrets are stored in the local desktop SQLite
database with user-only filesystem permissions and are never returned to the renderer.

## 中文

`dagent-ai-desktop` 是开源、本地优先 DagentWork 桌面应用的轻量启动包。安装时会通过可选依赖
自动选择当前操作系统与 CPU 架构的预构建包。

支持 Windows、macOS、Linux 的 x64 与 arm64。桌面端数据与 `dagent` CLI/Web 完全隔离。
模型密钥和 MCP 密钥按用户选择以明文保存到受当前用户文件权限保护的本地 SQLite，且不会返回渲染进程。
