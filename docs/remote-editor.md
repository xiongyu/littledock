# 远程 VS Code 插件

文件栏标题的代码图标、文件夹或空白处右键的“在远程 VS Code 中打开”会打开远程编辑器面板。使用当前 SSH 登录，无需再次填写密码，也不向交互终端发送安装命令。

首次使用检查系统并显示“安装并启动”；Windows 需阅读并勾选接受官方 VS Code Server 使用条款。完成后点击“打开编辑器”，在独立浏览器页编辑当前目录，保存直接写入远端文件。之后再次打开会复用远端安装。面板可收起，重新点入口查看状态或停止。

## 平台和安装包

| 远端 | 运行时 | 固定版本 |
| --- | --- | --- |
| Linux x64 / ARM64 | Coder code-server 独立压缩包 | 4.143.1 |
| Windows x64 / ARM64 | Microsoft VS Code Server Web 完整压缩包 | 1.143.1 |

Windows 使用官方 `server-win32-*-web` 发行物里的 Node 和服务器程序，不依赖桌面 VS Code、Docker 或 WSL。它是官方 `code serve-web` 使用的 Web 服务端，不是 Coder 的 Linux 包改名。

安装包采用**按需下载、本机缓存、校验后上传**。版本、官方下载地址与 SHA-256 固定在 `backend/src/plugins/remote-editor/packages.ts`，安装时不解析 latest；本机缓存命中不访问网络。每次使用先校验本机包，远端解压前再校验一次。下载中断清理 `.part`；损坏包不会执行，也不会悄悄覆盖。

默认缓存为 `<WebNav 数据目录>/editor-packages/`，Windows 通常是 `%LOCALAPPDATA%\WebNav\editor-packages\`。安装包不进入 Git、目录备份或前端构建。

可提前下载，将整个缓存目录随离线部署一起带走：

```powershell
pnpm editor:cache windows-x64 linux-x64
# ARM64 按需选择：windows-arm64 linux-arm64
```

可用 `WEBNAV_EDITOR_PACKAGE_DIR` 指定已有缓存位置；文件名及校验值必须与清单一致。不要每次启用插件都重新下载，也不默认给每个用户打包所有架构的几百 MB 安装包。微软二进制不直接放进本开源仓库，分发与使用仍遵循其条款。远端安装无需联网；之后安装扩展、加载外部资源可能仍需网络。Linux code-server 默认使用 Open VSX，扩展可用性与微软发行版不同。

## 环境和存放位置

远端必须支持 SSH exec、SFTP 与 TCP 转发，当前用户可写自己的主目录。Linux 需要 bash、setsid、tar、sha256sum、date、stat 以及当前发行包所需的 glibc / libstdc++；Windows 需要 PowerShell、Expand-Archive、Get-FileHash 和兼容随包 Node 的系统版本。失败会在面板保留状态，不回退成安装 Docker、WSL 或修改系统 SSH 配置。

远端安装到 `~/.webnav-editor/<平台>/<版本>/`，`data/` 保存编辑器设置和扩展，`sessions/<任务ID>/` 保存运行时文件。只处理插件自己创建的程序、通道和临时项，不修改现有 VS Code 安装。停止后保留安装包和编辑器数据以便下次复用。安装记录先写入校验后的解压目录，再整体移入版本目录；响应丢失不会留下已安装却无法识别的版本。发现没有安装记录的旧目录时，重新安装会将它保留为同级 `.incomplete-stage-<任务ID>` 备份，不要求用户手工搬移、不删除旧内容；已有有效或不匹配安装记录不会被直接覆盖。

Windows 安装关闭 PowerShell 进度输出，安装命令持续消费 stdout/stderr，以退出状态判断成功。stderr 只保留有界诊断尾部，不再将解压进度 XML 超过 64 KiB 当作安装失败；环境检测的结构化结果仍有输出上限。

## 连接和生命周期

```text
浏览器编辑器页面 → 本机独立回环端口 → SSH forwardOut → 远端 127.0.0.1:动态端口
```

`remoteEditor` 是独立 Cordis 服务，依赖 `sshFiles`、`sessions`、`credentials`、`auth`。准备、安装、查询和停止均为业务 WS RPC；编辑器自带的网页资源、文件协议和 WebSocket 经专用代理原样传输，不把第三方编辑器改造成小站 REST 接口。前端安装面板每 1.5 秒通过 WS 查询状态，关闭即停止查询。

远端仅监听回环；本机代理亦仅监听回环，校验 Host、页面会话和主密码状态，写请求与 WS 另校验 Origin。小站的 Cookie 不发送到远端。Windows 连接令牌由后端生成，通过 SFTP 文件交给服务器；上游 HTTP 使用专用 `vscode-tkn` Cookie，避免根页面 `?tkn=` 反复重定向。编辑器页面的官方 bootstrap 配置另携带本次令牌，用于 VS Code 应用层 WebSocket 握手；仅在页面内存中使用，不写本机持久存储或共享 localhost Cookie，不放入小站返回的入口 URL。含令牌的 HTML 禁止缓存并限制为 1 MiB；其他资源和 WS 持续转发。

Windows `folder` 保留 `/C:/...` 形式，让工作台识别为远端文件系统路径。当前固定发行包从 CDN 获取的中文语言资源在实测中存在索引错位，Windows 网页编辑器暂用随包英文界面；中文文件名和内容正常读写，小站界面仍为中文。

Windows 官方扩展市场的查询使用同源路径 `/_webnav/marketplace/extensionquery`：浏览器 → 已鉴权的本机编辑器代理 → 微软官方 HTTPS 市场。代理仅重写已知微软市场的 `serviceUrl`，固定请求目标、拒绝重定向，不转发页面 Cookie、认证头或编辑器令牌；自定义市场与 Linux code-server 的 Open VSX 配置保持原样。它是第三方编辑器协议的适配，不是小站 REST 业务接口。

市场查询限 POST、256 KiB 请求、64 MiB 解压后响应，每个编辑器最多 2 个并发查询，20 秒超时；编辑器停止时取消在途请求。返回数据不缓存、不截断版本或资源列表，浏览器支持时使用 gzip 压缩。兼容版本查询可能远大于普通搜索（Python 的完整版本资料已实测约 28.3 MiB），不能沿用页面 HTML 的 1 MiB 限额。扩展资源下载和安装仍遵循编辑器原有路径，此代理不代表离线安装或全部外部网络请求均经过 SSH。

关闭面板或编辑器浏览器页不停止远端进程；点“停止”、所属 SSH 断开、主密码锁定、页面身份到期、插件卸载或服务退出才清理。远端有独立的心跳文件看守：后端每 10 秒写一次，45 秒未更新则结束本次进程树，处理本机进程意外退出的情况。时钟取远端文件系统，避免两台机器时间不一致误停。正常关闭清理心跳、令牌和本次启动通道；远端安装与数据保留。

最多 4 个准备中或运行中的编辑器；单包 512 MiB、下载 10 分钟、整个准备过程 25 分钟、解压命令 3 分钟、启动 90 秒。代理有连接数和请求超时限制。当前未实现编辑器页关闭后的空闲回收、同一主机多个窗口共用单个远端进程、跨 SSH 断线恢复或升级/卸载管理界面；不同任务共享用户数据目录，并发打开的兼容性待真实编辑器验证。

首版用独立浏览器页，保留编辑器自己的 frame / CSP 策略，不嵌入工作台 Tab。插件随小站构建启用，不是 VS Code 内部的扩展；设置 `WEBNAV_EDITOR_ENABLED=0` 并重启可关闭能力。托盘启动和自启配置保存这两个 `WEBNAV_EDITOR_*` 环境设置。

## 验证边界（2026-10-26）

自动测试使用本机模拟 SSH / SFTP 验证平台检测、显式安装、Windows 条款门槛、缓存复用、上传、安装记录、重开、归属、锁定、取消与断线清理。HTTP / WebSocket 实际通过 ssh2 转发测试，覆盖 Host、Origin、Cookie 隔离。安装器和运行时在这些测试中被替换，不能视为真实 VS Code 远端兼容性通过。

Windows x64 官方完整压缩包已实际下载并通过清单 SHA-256 校验，核对了目录、Node 入口、启动选项和端口输出格式。在用户已从面板发起并接受条款的同一次安装修复中，已在用户指定 Windows 目标完成安装和真实网页编辑验证。Linux / ARM64 真实安装、扩展和大型工程性能仍需实际目标验证。

浏览器已用隔离数据库和模拟目标验证：文件栏入口、首次安装面板、进度、独立页打开、通过实际 SSH 转发保存中文文件、停止及状态更新。模拟工作台明确标注为测试页面，不是 VS Code 真机运行证明。[面板截图](design/screenshots/remote-editor-ready.png)。类型检查、生产构建、后端 60 项和前端 40 项测试通过。

### Windows 上传兼容修复

用户报告安装阶段只显示两次 `Failure`。在其指定 Windows 目标复现：16 B 和 32 KiB 的 SFTP 写入成功，128 KiB 写入返回状态 4。已在共享 SFTP 层按 32 KiB 拆分，业务 WS 仍保持 128 KiB 数据块；安装包和普通文件上传都受此修复覆盖。编辑器错误现在保留失败阶段并翻译 SFTP 状态，界面只显示一次错误。

修复后在该真实目标上传完整 Windows x64 安装包，远端 SHA-256 与固定清单一致，上传及校验约 13 秒，测试 ZIP 随后清理。此记录只证明真实上传及内容完整性，没有执行编辑器或替用户再次接受条款。新增受限 WRITE 服务和错误消息回归用例。

### Windows 安装与真实编辑验证

后续复现“远端响应过大”：500 次 PowerShell 进度输出产生约 114 KiB CLIXML，触发旧的 stdout/stderr 共用限制。修复后真实完整包上传、校验、解压与安装记录提交约 26 秒，原未标记目录已保留为备份。

继续真实浏览器验证，修复了三处模拟测试未暴露的链路问题：Node `agent:false` 忽略请求上的 `createConnection`、VS Code 根页面令牌重定向和后续应用层鉴权、Windows 盘符被当作 URI 协议。代理测试现在使用与本机监听端口不同的逻辑远端端口，必须真正经过 SSH 才能通过；并覆盖根页面重定向规则、bootstrap 令牌、Cookie 隔离及禁止缓存。

真实网页已打开独立验证目录，新建并保存含中文的文本；通过另一条已验证主机指纹的 SSH 连接读回，90 字节 UTF-8 内容与换行全部匹配。停止后重新启动编辑器，再次打开文件，中文内容正常。验证文件及空目录、临时本机服务已清理，远端安装保留。此次相关后端 17 项测试、全仓类型检查及生产构建通过；不将此验证延伸为 Linux、ARM64、扩展安装或大型工程性能通过。

### 扩展市场搜索修复（2026-10-27）

在用户指定的 Windows 目标“牧师”上，直接浏览器查询市场出现后续兼容版本请求挂起、搜索列表空白。改为本机同源市场查询，并保留大响应后，真实浏览器搜索 `python` 已显示 Microsoft Python、Python Debugger、Python Environments 等结果，Python 详情页可打开。该次完整版本资料约 28.3 MiB，经 gzip 传给浏览器约 860 KiB，数据内容保持不变。

相关自动测试覆盖固定上游、凭据隔离、Host / Cookie / Origin 校验、17 MiB 版本资料完整性及 gzip、无效请求、响应限额、错误、超时和关闭取消，共 16 项通过。此次只验证真实搜索和详情页，没有替用户安装扩展，不将结果延伸为所有扩展安装或运行兼容性通过。

## 官方依据

- [Coder 安装说明](https://coder.com/docs/code-server/install)及[SSH 转发指南](https://coder.com/docs/code-server/guide)
- [code-server 发行包和校验值](https://github.com/coder/code-server/releases/tag/v4.143.1)
- [Microsoft serve-web 实现](https://github.com/microsoft/vscode/blob/main/cli/src/commands/serve_web.rs)
- [VS Code Server 启动选项](https://github.com/microsoft/vscode/blob/main/src/vs/server/node/serverEnvironmentService.ts)
- [VS Code Server 使用条款](https://aka.ms/vscode-server-license)
