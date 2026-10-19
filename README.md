# WebNav

运行在本机的轻量服务器导航页。通过分组、搜索和收藏管理服务器，在同一个入口打开网页 SSH、Windows 远程桌面及服务器管理网站。

## 当前状态

项目目前已建立设计文档和前后端目录骨架，尚未实现应用代码、安装依赖或配置启动脚本。本文中的功能和技术选型是开发目标，不代表已经实现。

计划访问地址为 `http://127.0.0.1:3030`，端口可配置。正式运行时，由一个本地 Node.js 进程提供前端静态资源和 WebSocket。所有前后端业务通信统一走 WS，HTTP 仅负责页面、静态资源及 WS 升级握手，不提供 REST 业务接口。

## 文档

- [架构与实施方案](docs/architecture.md)：产品范围、插件设计、数据模型、连接流程、实施阶段和验收要求。
- [WebSocket 通信协议](docs/websocket-protocol.md)：RPC、实时订阅、鉴权、重连及终端数据通道。
- [终端历史与性能](docs/terminal-performance.md)：历史淘汰、滚动行为、输出缓冲和持续输出验证。
- [开发约定](AGENTS.md)：目录职责、编码规则和验证要求。
- [前端说明](frontend/README.md)
- [后端说明](backend/README.md)

## 目录

```text
webnav/
├── AGENTS.md
├── README.md
├── docs/
│   ├── architecture.md
│   ├── websocket-protocol.md
│   └── terminal-performance.md
├── frontend/
│   ├── README.md
│   └── src/
└── backend/
    ├── README.md
    └── src/
```

`src/` 暂用 `.gitkeep` 保留空目录。后续业务代码分别放入 `frontend/` 和 `backend/`。

## 功能目标

- 服务器分组、标签、搜索、收藏和最近使用。
- 一台服务器配置多个连接入口，分别保存协议、端口、用户名和凭据引用。
- 浏览器 SSH 终端，支持多个独立会话。
- 本机 Windows RDP 启动及 `.rdp` 文件下载。
- 服务器、分组和连接配置管理，支持导入预览和备份导出。

## 技术选型

| 部分 | 计划采用 |
| --- | --- |
| 运行时 | Node.js LTS、TypeScript、ESM |
| 后端组织 | Cordis 插件与服务 |
| 页面与握手 | Hono、Node adapter |
| 业务通信 | 浏览器原生 WebSocket、后端 ws；RPC + 事件订阅 |
| 前端 | Vue 3、Vite、TypeScript |
| SSH | xterm.js、ssh2 |
| RDP | Windows `mstsc.exe` |
| 数据存储 | SQLite、better-sqlite3 |

首版面向单用户 Windows 本机使用。后台以当前登录用户身份运行，仅监听回环地址。SSH 主机指纹、浏览器会话鉴权和凭据处理属于首版连接能力的一部分。

每个页面使用一个业务 WS 处理配置读写、连接启动和状态推送；每个 SSH 终端使用独立 WS 传输字节流。配置变更主动推送，前端无需轮询。重连后恢复订阅并获取一致快照；有副作用的请求不得因超时或断线自动重放。

## 开发与运行

目前没有可执行的开发、构建或测试命令。实现阶段采用 pnpm 管理前后端工作区，确认兼容的依赖版本后提交锁文件，并在本节补充经过实际验证的命令。

实施顺序为：工程脚手架与本地服务 → 导航及配置管理 → SSH 与 RDP → 自启、备份和使用体验完善。跳板机、SFTP 和网页 RDP 作为后续扩展。
