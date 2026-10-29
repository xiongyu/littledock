# 插件系统与公开市场（v1）

2026-10-29：[默认共享 / 声明独占 Worker](plugin-workers.md) 已接入开发及生产入口。任务管理器和系统优化各自独占一个 Worker，其余插件默认共享，主线程不导入插件业务。插件详情显示实际运行位置。当前 SDK 直接使用实现对象与异步宿主接口，不保留旧 Cordis 工厂、原始 Context 或同步租约入口；前端 Vue 仍在浏览器主线程。

2026-10-28：通用工具、设置、命名字体和插件间服务/状态通信首版已实现，实际接口见 [SDK](plugin-sdk.md)，验证见[实施记录](plugin-platform-implementation.md)。[框架审查](plugin-framework-audit.md)中的加载阻塞、可选契约、维护收尾及连接器串项已修复；历史内置服务仍有固定装配限制，不能通过插件管理器逐一卸载。

已增加 [MCP 自动化契约](mcp-implementation.md#插件接入契约)：保留必填 capabilities 的装配语义，新增可选 automation 声明和 registerAutomationTool 注册。旧插件可省略声明；空工具列表合法。插件详情显示 AI 能力与边界，内置 MCP 插件提供 AI 接入设置入口。

小站支持从公开 HTTPS Git 地址安装插件，并让用户替换内置能力。市场是一个公开索引，不托管插件代码，也没有账号、评分或评论系统。

默认索引仓库：[axisxy/webnavpluginsmarket](https://gitee.com/axisxy/webnavpluginsmarket)。根目录为 `index.json`，默认读取仓库 HEAD。索引更新不自动升级已经安装的插件。

内置[配置同步插件](config-sync.md)提供 GitHub / Gitee 加密存储、自定义同步账号密码、冲突预览与历史恢复。能力为 `service:configSync`，插件中心详情与全局设置均可打开专用面板；令牌和同步密码不使用公开 `configFields`。

任务管理器内置提供者为 `builtin.taskManager`（系统监控分类），新增 `service:taskManager@1` 与前端 `task-manager` 槽位。服务实现 start/status/install/hostKeyDecision/snapshot/details/prepareAction/applyAction/close/closeOwner/hasResources，并提供 size/sizeRemote 计数。活动安装、采集和未完成清理等待结束后切换；等待期间拒绝新监控。采集器由完整安装包分发，目标用户目录 `.webnav/tools/task-manager` 与宿主插件数据分开，退出只清理本次运行资源。首版不开放自动化工具，详见[任务管理器](task-manager.md)。

## 官方随附独立插件

`plugins/` 中的独立包随小站发布和通用发现，系统优化为首个接入项。页面标记“官方 · 内置”，支持停用、卸载及发现页恢复安装，且保留状态与数据；它与仍不可单独卸载的旧固定内置服务分别处理。详细生命周期见 [SDK](plugin-sdk.md#启用停用与卸载)。

## 使用

插件中心默认“已安装”，卡片提供打开、设置、停用/启用和卸载。设置支持声明式表单或独立页面，总览齿轮与插件内按钮共用同一实例和草稿，字体按“插件名 · 字体名”展示。停用保留已安装卡片和配置入口；卸载撤销已安装登记与展示，保留本地代码、缓存、配置和数据，活动资源结束后收尾。详情继续区分目标状态与实际运行状态。

左侧「插件中心」提供发现插件、已安装与 Git 地址安装。默认按 **运行小站后端的宿主系统 / Node 进程架构**筛选，不按浏览器系统或远程服务器系统判断。可以取消「适合本机」查看全部。

安装流程：填写地址与分支 / 标签 / 提交 → 读取说明、解析具体提交 → 检查兼容、依赖与生效方式 → 阅读风险并勾选确认 → 安装 → 设为默认实现。无必填配置的功能插件安装后自动启用；有必填配置时先填写再启用。读取说明不执行 checkout、依赖安装或插件代码；确认后才检出已确认的提交，并执行作者声明的安装步骤。

检查更新显示当前与目标版本/提交，区分升级、同版本代码变化和降级；相同提交无需重复安装。预览列出静态能力、AI 工具、依赖与安装步骤等声明差异，不代表代码审查。预览绑定读取时的插件配置版本，其他窗口修改设置后须重新读取并确认；不能用最新配置版本继续确认旧预览。详情分别显示已安装与正在运行的版本，等待切换或激活失败时也能核对实际运行代码。

更新与插件的上游调研、取舍及未实现的宿主整包更新方案见 [Harness 调研](harness-updates-research.md)。

已安装的外部功能插件默认支持热插拔和热更新：启用、禁用、默认实现、配置、升级、回退、卸载在运行中生效，业务 WS 和页面保持运行。内置条目提供恢复默认实现，其随附代码更新仍由宿主版本更新承担，当前不提供独立禁用/卸载。纯主题安装后立即可用，见下方「主题下载」。

生效状态有四种：

- **已生效**：新实现完成校验与切换，其他已打开页面自动同步；未改动的插件视图保持原实例。
- **等待使用结束**：相关 SSH、本地终端、桌面、设备或插件任务正在使用；保留现有连接，暂停受影响的连接器接收新连接，资源结束后自动切换。配置同步需先锁定同步，截图任务等待完成。
- **待重启**：作者声明 `reload: "restart"`，或旧插件资源未能完整清理；明确显示原因，允许稍后统一重启，不妨碍独立插件热加载。
- **更新未生效**：新实现加载或注册失败，保留原运行实现并展示原因，可重新启用 / 设为默认重试，或回退上一版。

需要重启时，Windows 托盘选择「重启」，前台模式重新启动服务。重启会断开活动网页连接，不自动重连，不终止用户的 mstsc 会话。升级小站宿主本身仍需重启一次，插件热更新不能替代宿主更新。

多个提供者可以同时安装。连接器可在每个连接入口选择提供者，也可跟随默认。服务替换是整个服务契约的替换；多个服务能力共同提供时，设为默认会一次保存整个插件的选择。切回某个内置能力会清除原插件的整组默认选择。核心鉴权、凭据、目录存储、插件管理与通信基础设施不可替换。

## 内置、官方、第三方

- **内置 · 官方**：随应用分发的内置能力，从当前项目 `backend/plugins/builtin.*/` 读取清单、图标和 README；不需要网络。运行实现仍在 `backend/src/plugins/`。
- **官方**：公开市场索引中，由索引维护者设置 `publisher: "official"` 的独立插件。
- **第三方**：索引默认标记以及未收录的 Git 地址安装。插件自己的作者字段不能授予官方标记。

来源标记表示来源，不表示安全认证。图标需要在插件仓库中提供 SVG、PNG 或 WebP（最多 128 KiB），不直接执行 SVG。README 以纯文本显示，避免执行作者 HTML。作者截图与主页作为外链打开，不自动加载追踪资源。

## 缓存与数据

所有插件数据位于本机数据目录的 `plugins/`，不写入宿主源码或依赖目录：

| 路径 | 内容与策略 |
| --- | --- |
| `registry.json` | 已安装提交、配置、启用状态、默认提供者；带修订号，临时文件写入后原子替换 |
| `repositories/<sha256>/` | 按仓库地址分开的 bare Git 缓存；保留已读取提交，不自动删除 |
| `metadata/<sha256>.json` | 按仓库与 ref 缓存清单、README、图标和读取时间；跨刷新、跨重启保留 |
| `market.json` | 最后一次有效索引；读取失败继续使用缓存并显示时间与错误 |
| `releases/<id>/<commit>/` | 每个提交的独立安装目录；功能插件提供本次进程已加载版本的前端资源，供尚未切换的页面继续加载分块；纯主题保留旧版本已声明的背景资源，供浏览器保存的外观继续使用 |
| `data/<id>/` | 插件自己的数据目录；卸载不删除 |

打开市场五分钟内复用索引；手动刷新强制更新索引。卡片每批显示 48 项，按需显示更多；每批最多并发读取两个仓库，已缓存的详情直接使用；详情页「更新说明与图标」显式重读。安装和检查更新始终重新读取目标 ref，并绑定当次提交。卸载保留数据、安装目录与仓库缓存，不自动清理用户的副本。

下载或安装步骤失败不改变已安装记录。安装成功但热加载失败时，已安装版本和运行版本可能不同：目标设置保留，当前进程继续使用旧实现，界面明确显示未生效；重启会尝试目标版本。回退上一版只切换代码，不承诺回滚数据。`dataVersion` 变化时阻止直接升级；v1 不自动执行破坏性迁移，作者需要另行提供可审查的备份和迁移工具。缺失插件的连接入口、`providerId` 与公开配置在保存和导入导出时保留，连接时明确报告不可用。

## 固定分类

选择一个主分类，最多两个不重复的次分类。不支持自定义分类；分类不参与能力路由。

| ID | 名称 | ID | 名称 |
| --- | --- | --- | --- |
| terminal | SSH 与终端 | desktop | 远程桌面 |
| files | 文件管理与传输 | servers | 服务器与分组 |
| bookmarks | 网页收藏与导航 | monitoring | 系统监控 |
| services | 服务与容器 | databases | 数据库工具 |
| network | 网络工具 | automation | 自动化与任务 |
| exchange | 数据导入与导出 | backup | 备份与恢复 |
| themes | 主题 | appearance | 外观与工作区 |
| productivity | 搜索与效率 | integrations | 通知与集成 |
| development | 开发与诊断 | | |

## 仓库规范

根目录必须有 `webnav.plugin.json`。一个仓库提供一个插件，示例见 [午夜配色插件](../examples/plugins/midnight-themes/README.md)，可把该目录原样拆到独立仓库安装。插件 ID 采用 `作者.插件名`，不能使用 `builtin.*`。

```json
{
  "schemaVersion": 1,
  "id": "author.plugin",
  "name": "插件名称",
  "version": "1.0.0",
  "description": "说明用途及边界",
  "author": "作者",
  "license": "MIT",
  "category": "appearance",
  "secondaryCategories": ["terminal"],
  "apiVersion": 1,
  "webnav": "^0.1.0",
  "node": ">=22.12.0",
  "platforms": [{ "os": "win32", "arch": "x64" }],
  "capabilities": [{ "id": "service:terminalThemes", "version": 1 }],
  "backend": "backend.mjs",
  "frontend": "ui/index.js",
  "icon": "icon.svg",
  "readme": "README.md",
  "dataVersion": 1
}
```

`platforms` 必须列出实际支持的 OS / 架构组合，OS 为 win32 / linux / darwin，架构为 x64 / arm64，可加 `minRelease`。纯前端插件也须明确声明组合。实际清单是安装依据，索引的平台字段只用于初步筛选。安装、启用、升级、启动都会检查版本范围、Node 版本、平台、最低系统版本、已启用插件依赖和外部组件是否存在。二进制、Node ABI、浏览器能力的详细要求由作者正确限定版本和平台，并在实现中检查；不能将平台检查通过称为兼容性实测。

可选字段：

- `dependencies`: `{ "other.plugin": "^1.0.0" }`，必须先安装并启用；不自动安装隐式依赖。
- `commands`: `['git', 'node']`，检查外部程序是否可找到；不在风险确认前执行它们探测版本。
- `install`: `[{ "command": "npm", "args": ["ci"] }]`，有序执行，禁止拼接 Shell；无步骤时只检查已有产物。Windows 的 npm 通过 Node 运行 npm-cli；其他安装程序应使用可执行文件，不依赖 `.cmd` Shell 包装。
- `styles`: 前端入口同一资源目录中的 CSS 文件列表；前端必须是已经构建好的浏览器 ES module，禁止要求重建小站。
- `homepage` / `screenshots`: HTTPS 介绍链接 / 最多八个截图链接；`changelog`: 仓库内相对路径。
- `configFields`: `[{"key":"title","label":"标题","type":"string","required":true}]`，类型为 string / number / boolean；仅用于非秘密配置，不用作密码框。
- `reload`: `"hot"`（省略时默认）或 `"restart"`；无法可靠释放进程级组件、全局补丁或原生库的插件声明 restart。可用 `reloadReason`（最多 500 字符）说明原因，安装前展示。旧版或新版任一声明 restart，本次切换均待重启。

## 后端 SDK

入口导出 `activate(api)`。SDK 运行时由宿主传入，类型入口为 [backend/src/plugin-api.ts](../backend/src/plugin-api.ts)。插件不依赖相对导入宿主源码，也无需运行时加载另一份 Cordis。

| API | 约定 |
| --- | --- |
| `api.apiVersion`、`manifest`、`config` | 当前契约和只属于本插件的公开配置 |
| `api.shared` | 公开 DTO 校验、配色解析等共享契约 |
| `api.dataDirectory` | 独立持久数据目录 |
| `registerService(name, implementation)` | 声明 `service:<name>@1` 并注册实现对象；不接收 Cordis factory/inject。资源通过 `onDispose` 清理，跨线程方法使用可序列化参数与结果 |
| `registerConnector(type, handler)` | 声明 `connector:<type>@1`；按插件 ID 隔离多个提供者；handler 收到 owner、已保存的 serverId / connectionId |
| `registerRpc(name, { mutate, handler })` | 方法限定为 `plugin.<插件ID>.<name>`，输入是 unknown 字段，需要插件校验；有副作用必须 mutate=true，复用宿主操作去重 |
| `onDispose(cleanup)` | 注册可重复、安全的生命周期清理 |
| `await api.host.acquireResource()` | 连接或长任务开始时取得租约；返回幂等释放函数，结束时必须调用。等待更新时拒绝新租约；已有任务仍可调用 RPC 完成或释放 |
| `beforeUnload(check)` | 可返回 Promise；原因字符串表示等待，undefined 表示可切换。检查必须有界，不执行破坏性操作 |
| `api.host.vaultStatus()` | 异步读取是否解锁；不公开原始 Context、数据库对象或秘密 |

宿主自动跟踪插件 RPC、连接器启动处理及服务方法返回的 Promise；持续 WS、SSH channel、子进程、后台任务等通过异步宿主租约标明使用期，并通过 `onDispose` 清理。订阅和注册方法必须返回幂等清理函数；服务桥接在替换时迁移订阅与注册，避免重建通信服务。相关依赖及共同能力一起切换，独立插件可单独生效。

后端 `activate` 在提交切换前运行，注册暂存至校验及 Worker 就绪完成；失败时撤销暂存注册并清理候选实例。作者不得在 activate 中立即迁移共享数据或进行不可撤销操作；宿主不能撤销第三方代码已经造成的外部副作用。前后端导入及激活期限为 15 秒；独占 Worker 的同步死循环由协调端心跳监测并终止，共享组阻塞则由主线程检测并报告。清理期限和故障处理见 [Worker 执行模型](plugin-workers.md)。ES module 按不可变提交路径加载，清理释放的是运行资源，不承诺从 Node / 浏览器模块缓存卸载代码。无法履行生命周期契约的插件应声明 restart。

服务能力包括 sessions（SSH）、desktops（VNC / 桌面通道）、freeRdp（网页 RDP）、rdp（系统 RDP）、terminalHistory、terminalThemes、webBookmarks、sshInspector、sshFiles、remoteEditor、local、adb、wdb、configSync、taskManager。方法和数据以当前模块公开契约与 shared DTO 为准；任务管理器的 Worker 契约集中在 `backend/src/plugins/task-manager/contract.ts`。不再导出从整个 Cordis Context 提取的 `ServiceContract<K>`。现有业务 RPC 和专用 WS 的页面协议保持不变。

本次开发版直接迁移 SDK，仓库内插件同步更新，不保留旧签名适配。替代 SSH 仍须提供所属会话、独立通道和流控契约；替代桌面仍须保留一次性绑定与资源归属；认证秘密不进入普通配置或 RPC 查询响应。插件使用完整本机权限，Worker 不隔离恶意插件。

## 前端 SDK

前端入口导出 `activate(api)`。使用 `api.vue` 的宿主 Vue 实例，不能再打包一份 Vue。通过 `api.rpc(name, params, mutate)` 调用本插件 RPC，通过 `api.hostRpc` 使用公开宿主 RPC。`api.onDispose` 清理监听器和样式等资源。

`registerView(slot, component)` 可接管 terminal、desktop、connection-form、bookmarks、system、files、history、themes、task-manager。只有被选为相应服务默认实现的插件才能占用槽位；组件 props / emits 以原内置组件公开接口为准。后端切换后通过 `plugins.watch` / `plugins.changed` 通知页面，浏览器只加载变化的插件并移除旧样式、监听器；不用刷新页面。视图加载失败保留旧视图并显示插件错误，后端可能已切换，作者须保持同一 API 版本兼容。组件自身资源在卸载钩子清理，插件级资源通过 `api.onDispose` 清理；自定义长连接也应由后端租约保护。

`registerConnector(type, {name, port, form?, open?})` 声明表单与可选打开交互。内置类型为 ssh / rdp / vnc / web / local / adb / wdb；新类型以 `plugin:<type>` 存入目录。`form` 接收 connection / serverId 并发出 update:connection；`open` 接收已保存的 serverId / connectionId，可通过 hostRpc 调用连接器并管理自己的视图。复用内置工作区的连接器需要遵循相应会话票据和专用 WS 契约。新协议视图不自动拥有 SSH 分屏或桌面视频能力。

## 通用工具入口提案

本节保留原提案的链接锚点；工具入口现已实现，公共接口以 [SDK](plugin-sdk.md) 为准。完整平台方向见[通用插件平台](plugin-platform.md)，其中更多插槽及旧业务全面拆包仍待实施。

状态：通用注册首版已实现，最低宿主版本 0.1.1。适用于[系统优化](system-optimizer.md)及后续独立工具页面。框架补一次通用声明、注册和承载能力；新增工具插件不再逐个修改 `App.vue`、导航按钮、服务白名单或固定 `frontendSlots`。现有 `registerView` 继续用于替换既有能力，工具页面通过独立注册表承载。

插件在清单中声明可见入口，前端激活时注册组件。清单片段如下；完整必填元数据见独立示例：

```json
{
  "capabilities": [{ "id": "extension:system-optimizer", "version": 1 }],
  "contributes": {
    "tools": [{
      "id": "main",
      "title": "系统优化",
      "icon": "icon.svg",
      "placement": "sidebar.tools"
    }]
  }
}
```

前端使用 `api.registerTool('main', { component: OptimizerPage })`，由框架从已校验声明取得名称、图标和位置。该 API 不返回注销函数；注册归属插件作用域，由框架统一移除和清理。组件使用宿主 Vue，接收 `active` 状态以暂停不可见页面的展示刷新，不能直接向宿主 DOM 插入按钮。

职责划分：

| 归属 | 负责内容 |
| --- | --- |
| 插件 | 入口名称与图标、受支持的位置、页面组件、内部页签、业务校验与 RPC、后台任务和数据 |
| 框架 | 清单校验、组件注册表、动态导航、通用工作区标签、可见状态、错误边界及生命周期协调 |
| 公共契约 | 通用工具声明与注册类型；业务 DTO 和规则保留在插件，不按插件扩充宿主类型 |

首批开放 `sidebar.tools`，即现有左侧「工具」区。未来需要其他入口时由框架增加通用位置，而不是让插件传 DOM 选择器、任意插入点或覆盖已有按钮。此字段与市场分类无关；标题按纯文本渲染，图标沿用插件本地资源与安全加载规则。

声明要求存在前端入口及相应扩展能力，局部工具 ID 唯一，名称、数量及资源路径有界。运行时只接受本插件已声明的 ID，不允许注册到其他插件名下或冒充内置入口。工具全局身份由插件 ID 与局部工具 ID 组成，例如 `plugin-tool:webnav.system-optimizer/main`，宿主不得据此添加业务分支。最低宿主版本必须限定在真正提供此 API 的发行版本；旧插件无需声明工具，行为保持兼容。

框架同时处理清单校验、`plugins.assets` 的运行版本声明输出和前端暂存注册；不能只在页面加一个数组。入口只有在插件实际启用、前端激活完成且所需后端运行就绪后出现，不能依据“已安装”或目标设置判断可用。注册失败只影响所属插件，重复注册报错，未变更插件的入口和组件保持稳定。

点击入口创建或激活通用工作区标签；重复点击复用同一实例，切换目录或终端仅切换可见状态。关闭工具标签卸载该页面，后台任务是否继续由插件已声明的业务生命周期处理，不能顺带关闭 SSH 或桌面。停用/卸载先按已有租约等待任务安全收尾，等待期间标记入口不可启动新任务，完成后移除入口、标签和监听；不因空闲页面仍打开而无限等待。当前工具移除后聚焦最近可用标签或目录。

热更新将新声明、组件和样式暂存，成功后按插件整体切换；候选失败保留旧运行入口与旧页面并显示原因。UI 与后端跨版本须保持兼容，未切换页面仍使用对应不可变资源路径。注册、注销、页面卸载与插件清理均幂等。任务管理器工具入口已迁入此机制；其后端仍保留旧固定服务槽兼容装配。

验收使用两个隔离示例插件：同名工具但不同插件 ID 可并存；安装启用显示、停用移除、重复点击聚焦；未声明/重复 ID 拒绝；加载失败不影响其他工具；热更新失败保留旧版本；有任务时等待收尾；当前页移除有落点；既有终端不重连。纯工具插件无需注册宿主服务提供者，也无需在宿主写入自己的名称、ID 或业务方法。

## 市场索引

```json
{
  "schemaVersion": 1,
  "plugins": [{
    "id": "author.plugin",
    "name": "插件名称",
    "description": "插件简介",
    "repository": "https://gitee.com/author/plugin.git",
    "ref": "HEAD",
    "publisher": "community",
    "category": "appearance",
    "secondaryCategories": ["terminal"],
    "platforms": [{ "os": "win32", "arch": "x64" }]
  }]
}
```

索引只保存发现信息与来源标记；真实图标、说明、版本与兼容声明从插件仓库读取。提交收录 PR，维护者合并 index.json 即发布。无需把内置插件复制进远程索引，客户端总是从当前安装路径加入内置条目。

## 风险与恢复

安装或更新前明确显示插件名、源地址、版本与具体提交，风险勾选默认关闭。重点提示账号、密码、私钥、本地数据与远程操作风险，并高亮建议先使用 AI 审查源码、依赖和安装步骤；AI 可能遗漏问题，不是安全保证，不向 AI 提交真实凭据或服务器数据。

如第三方阻止正常启动，设置 `WEBNAV_DISABLE_PLUGINS=1` 后重新启动，将跳过全部第三方代码、使用内置服务。插件记录与数据保留，可以在插件中心恢复选择。解除环境变量后再启动恢复正常加载。

初次实现的边界：没有插件沙箱、强制 AI 审核、数字签名、评分、评论、后台自动下载更新、自动数据迁移、远程私有仓库认证或依赖版本自动探测。热更新指用户确认安装后在线切换，不会自动拉取执行仓库最新代码。完整服务替换仍需作者实现原契约；可安装不意味着自动兼容。

## 主题下载

「主题」是独立分类 `themes`，与工具型的「外观与工作区」分开。纯主题仓库声明 `theme:appearance@1`，不包含 backend、frontend、styles 或 install；只下载配色与背景资源。示例见 [深海主题](../examples/plugins/deep-sea-theme/README.md)。

```json
"category": "themes",
"capabilities": [{ "id": "theme:appearance", "version": 1 }],
"theme": {
  "background": "#eaf1f4",
  "sidebar": "#132c3b",
  "accent": "#237a82",
  "backgrounds": { "left": "images/left.webp", "right": "images/right.webp" }
}
```

backgrounds 可省略。纯主题安装后可以立即应用，无需重启，也能在右上角外观设置选择。当前选择仍只保存在浏览器，不修改后端服务器目录。左右背景继续支持上传和移除。主题升级不会自动改变用户已保存的配色，重新应用后使用新资源。升级、回退、卸载保留旧主题背景资源，当前已应用的外观可继续显示；恢复默认外观即可回到内置主题。

## 本次验证

`builtin.local`、`builtin.adb`、`builtin.wdb` 随应用提供独立清单、图标、README 和实现入口；分别声明 `service:local/adb/wdb` 与对应连接器能力，直接出现在内置列表。用法与实机验证见 [本地 / 安卓 / WDB](local-adb-wdb.md)。`backend/src/plugin-api.ts` 额外导出 `TerminalProvider` / `TerminalProcess`、`DeviceProvider` / `DeviceStream` 类型；替换 `sessions` 需支持 `register` / `closeAttached`，`sessions` 与 `desktops` 需提供只读活动计数 `size`，供共同连接预算使用。

2026-10-27：类型检查与生产构建通过，后端测试 112 项、前端测试 42 项通过。插件专项 13 项覆盖清单校验、持久缓存、风险确认、提交锁定、平台与依赖阻断、失败更新、静态主题资源保留、索引离线回退，以及在线安装 / 升级 / 禁用 / 恢复、订阅延续、资源租约等待、声明待重启、清理失败提示及独立插件互不阻塞。活动终端专项另使用真实本地 PTY 与终端 WS，验证等待切换时仍可输入输出，关闭后自动完成切换；不把该项描述为真实远程 SSH 验收。

浏览器验收使用独立临时数据与本机 Git 测试仓库，读取真实公开市场索引，验证图标、来源标记、筛选、风险勾选、生效方式、Git 安装、不重启后端 / 不刷新页面的视图替换、其他已打开页面自动同步、恢复内置、主题即时应用与刷新保留、恢复默认配色及 390px 窄屏。没有连接真实服务器，也没有验证任意第三方插件兼容性。示例插件只存在于项目示例和测试仓库，公开索引不收录虚构地址。

[市场页面](design/screenshots/plugin-market.png) · [风险确认](design/screenshots/plugin-risk.png) · [窄屏页面](design/screenshots/plugin-market-mobile.png)
