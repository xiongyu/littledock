# WebNav

运行在本机的轻量服务器导航页。使用分组、搜索和收藏管理服务器，在浏览器打开 SSH 终端，或启动本机 Windows 远程桌面。

## 当前功能

- Vue 3 导航与独立管理页：服务器多入口、批量操作、最多 5 层分组、固定宽度卡片、主题与左右独立背景。
- Cordis 本地服务，Hono 提供页面，业务通信全部使用 WS。目录保存在 SQLite，刷新与重启后保留；初始目录为空，不加载演示服务器。
- 管理中心“导入本机 SSH”：读取当前用户的 ~/.ssh/config，预览后事务替换目录，保存用户名、端口和私钥文件引用；不自动连接，不猜测操作系统或自动添加 RDP。
- SSH 使用 ssh2 + xterm.js，保存密码或私钥口令，主机指纹确认、默认整块右侧工作区与自适应标签；可同时悬浮多个终端、拖动缩放并收回标签页。默认 2,000 行滚动历史和累计字节 ACK。
- 右上角“全局设置”统一管理主密码：默认 Base64 可逆编码，设置主密码后所有已存密码统一迁移为 scrypt + AES-256-GCM 加密。首次访问统一解锁，有效期支持分钟、小时、天或服务运行期间永不过期；刷新与新标签共享有效期。私钥文件保持原路径。
- 独立“查看历史”对话框：选择会话、固定查询范围、搜索、分页和手动刷新。后端保存纯文本，不保存原始终端录像。
- Windows RDP 在编辑入口中直接填写密码，与服务器配置一起事务保存；启动时向 Windows 传递已保存凭据并用 mstsc.exe 打开，只报告“客户端已启动”。网页入口使用已校验的 HTTP(S) URL。

VNC、真实卡片截图、.rdp 下载、跳板机与 SFTP 尚未实现。最近使用暂为本页状态。8 个终端上限与历史存储额度不代表已完成容量压测。

## 运行

已验证 Node.js 24.16.0、pnpm 12.4.2。首次运行：

~~~powershell
pnpm install
pnpm build
pnpm start
~~~

打开 http://127.0.0.1:3030/ ，页面自动连接本机服务，无需配对。没有设置主密码时直接进入；设置了主密码且尚未解锁时输入主密码。

开发只需一个终端：

~~~powershell
pnpm dev
~~~

根目录与 `frontend/` 下的 `npm run dev` 也启动同一个前后端启动器，不会只启动静态页面。直接打开 http://127.0.0.1:5173/ 即可，管理中心地址为 /#manage。页面自动建立本机会话并通过 WS 加载目录，不需要先访问其他端口、输入配对码或手动授权。开发后端使用 Node 原生 TypeScript 执行，不自动热重载；修改后端需重启启动命令。Ctrl+C 关闭本次启动的前后端；兼容且已运行的后端会复用，不随启动器退出而关闭。`pnpm dev:ui` 仅用于已有后端的前端单独调试。

数据未加载时显示“目录尚未加载”，不显示 0 台或“还没有服务器”；连接中断时保留本页上次读取的目录，并暂停目录操作。浏览器缓存不是数据库，数据默认始终在 `%LOCALAPPDATA%/WebNav/webnav.sqlite`，与从哪个代码目录启动无关。

~~~powershell
pnpm typecheck
pnpm test
pnpm build
~~~

数据默认在 %LOCALAPPDATA%/WebNav/，可用 WEBNAV_DATA_DIR 改变；WEBNAV_PORT 默认 3030，WEBNAV_UI_PORT 为开发页面端口，默认 5173。生产静态资源与业务 WS 同源，服务器只监听 127.0.0.1。

## 目录与文档

- frontend/：Vue、管理表单、业务 WS 客户端、xterm 终端与历史对话框。
- backend/：Cordis 装配、HTTP/WS、SQLite、凭据、SSH/RDP 与历史留存。
- shared/：公开目录 DTO、格式校验，不包含后端实现或凭据。
- docs/：设计与实施说明；设计图在 docs/design/。

[架构](docs/architecture.md) · [管理页](docs/management.md) · [凭据](docs/credentials.md) · [WS 协议](docs/websocket-protocol.md) · [终端性能](docs/terminal-performance.md) · [输出历史](docs/terminal-history.md) · [主题](docs/ui-design.md) · [卡片预览](docs/session-preview.md) · [开发约定](AGENTS.md)

## 验证范围

自动测试覆盖目录校验、事务与版本冲突、WS 鉴权/Origin/Host、操作去重、目录订阅、跨重启保存、统一开发启动与自动连接、全局凭据迁移及回滚、共享解锁有效期、模拟 SSH 密码/私钥认证、指纹变化阻断、字节 ACK/背压、历史固定范围/跨页搜索/清理提示、遮罩拖选关闭保护，以及 RDP 密码事务与 Windows 凭据交接。前端 24 项、后端 13 项测试通过（Windows 原生交接测试在非 Windows 平台跳过）。

浏览器用独立本机模拟 SSH 服务验证 4,500 行输出、有限滚动历史、历史查找、多终端和关闭。未使用真实远端服务器进行连接测试，未验证 RDP 远端登录，也未进行长时内存或磁盘容量压测。真实目录、凭据和数据库不进入 Git。
