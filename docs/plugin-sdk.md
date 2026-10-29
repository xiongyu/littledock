# 通用插件 SDK v1

## 后端线程（宿主 0.1.2 起）

后端默认共享 Worker；`execution: { "backend": "dedicated" }` 声明专用 Worker，导入和回调均在对应线程执行，主线程不加载插件业务。两种模式均支持 `await api.host.vaultStatus()` 和 `await api.host.acquireResource()`，后者返回幂等释放函数。任务管理器与系统优化各声明独占线程，其他现有插件默认共享。已删除 `api.services`、同步 `api.acquireResource()` 及 `registerService(name, inject, factory)`；服务改为 `registerService(name, implementation)`，跨插件协作使用 interop，不保留旧接口适配层。线程之间不传递 Cordis 对象或活动流。完整边界见 [插件 Worker](plugin-workers.md)。使用新接口或声明时设置 `webnav: "^0.1.2"`。

## 控件、菜单与跨插件界面扩展

已实现 `api.menus` 与 `api.ui`，支持菜单、标签页、面板、操作栏注册，公开实例查找和激活。完整标识为 `插件 ID/控件局部 ID`，默认公开，手动 `public: false` 则不允许其他插件查找或添加内容。每个控件和上下文字段必须提供用途说明；优先查询 [静态扩展点表](plugin-ui-catalog.md) / [JSON](plugin-ui-catalog.json)，具体注册、上下文、生命周期与调试插件接法见 [界面扩展 SDK](plugin-ui-extensions.md)。

## 可选会话恢复能力

内置后台会话的恢复约定见[后台会话](persistent-sessions.md)。这是可选能力扩展，没有把新方法加入旧服务替换的必需方法列表。替换 `sessions` / `desktops` 的服务可实现 `list(owner)` 返回公开运行描述、`ticket(owner,id)` 返回新的一次性绑定票据、`counts()` 返回已建立数量（终端为 `{ssh,local}`，桌面为 `{rdp,vnc}`）；必须保持归属、解锁、单次票据和旧 WS 输入隔离。未实现者不提供恢复，计数显示未知。

桌面提供者返回的 Duplex 可声明 `viewerVersion: 1` 及 `setViewer(attached:boolean)`，负责暂停旧显示、释放输入、清除旧 ACK，并在新观看时生成独立可解码的画面。设备提供者可声明 `viewerVersion: 1`，须支持隐藏消息释放控制与暂停视频、重新显示/关键帧消息恢复解码起点。未声明者保持显示断开即释放的兼容行为；不得仅增加标记就宣称支持恢复。

宿主最低版本 `0.1.1`。本页记录已经实现的公共入口；[平台设计](plugin-platform.md)中的命令面板、更多展示位置、契约默认提供者选择等仍是后续范围。

## 发布目录与发现

插件根目录包含 `webnav.plugin.json`、图标、README 和可直接运行的 ES module。前后端业务入口、设置入口各自放在独立目录。宿主从清单发现能力，不需要修改 `App.vue`、宿主导航或服务名称白名单。可复制独立示例：[协作计数器](../examples/plugins/collaboration-source/README.md)、[协作观察器](../examples/plugins/collaboration-client/README.md)。示例不自动安装到用户目录。

`contributes.tools` 声明局部 id、中文标题、可选图标和 `placement: "sidebar.tools"`。前端 `activate(api)` 调用 `api.registerTool(id, { component })`；Vue 通过 `api.vue` 提供，不另加载一份 Vue。宿主生成侧栏按钮和工作区标签。`api.openTool(id)` 打开本插件工具。组件接收 `active`，切换页面保留组件；插件停用或卸载后销毁。

前端公开类型：[plugin-api.ts](../frontend/src/plugin-api.ts)。后端公开类型：[plugin-api.ts](../backend/src/plugin-api.ts)。宿主通过对象传入运行能力，插件不能运行时导入宿主源码。

业务与设置入口均提供只读响应式 `api.hostState`，值为 `connecting/offline/locked/ready`。插件观察它以暂停操作、清理敏感临时内容并丢弃迟到响应；恢复连接后由用户重新读取，不自动重放写入。此状态变化不重建其他健康终端。

## 设置与字体

设置可选，有 `configFields` 时自动生成表单；`contributes.settings` 提供 `id: "main"`、标题、独立 `entry`、可选 `styles` 可改用自定义页面。设置模块导出 `activate(api)` 并注册 `api.registerSettingsPage("main", { component })`。该入口在业务停用时仍能加载，恢复模式只展示基础配置。

`api.config` 是当前设置页的公开配置草稿，字段仍须在 `configFields` 声明。宿主保存按钮负责字段校验、配置 revision 和安装提交校验、保存反馈；总览设置按钮和 `api.openSettings({ section })` 共用一个标签及草稿。`section: "fonts"` 定位字体页。业务组件可通过自身按钮调用 `openSettings`；不用自行插入宿主 DOM。

自定义页面的独立业务操作可调用本插件 `api.rpc`，停用时拒绝业务调用。秘密不进入公开配置；秘密出口和独立保存流程由对应业务继续管理。`setDirty(boolean)` 可提醒存在自定义未保存内容，但不会替插件实现秘密或任意数据的持久保存。`onDispose` 收回设置临时资源。关闭存在修改的页面可继续编辑、放弃或保存后关闭。

字体描述通过清单 `contributes.fonts` 或激活时 `registerFontInfo` 注册，字段为 `flag/name/group/defaultSize/minSize/maxSize`。使用 `getFontInfo(flag).size`，该只读响应式值包含用户覆盖；默认字号只在注册处填写。公开身份为插件 ID + flag，设置显示插件名称、字体名称和分组。字号即时生效、保存在当前浏览器，卸载撤销展示但保留覆盖；重新安装相同 flag 可恢复。禁止临时随机 flag 和把字号散落在新 UI 中。

## 后端服务与状态订阅

在 `interop.provides` 声明命名空间契约 id、整数 version、方法的输入/输出 JSON Schema 和 access（read/write/finish）、状态主题的 Schema。`interop.requires` 声明同名契约、版本、可选 provider 和 optional。与 `service:*` 固定宿主服务替换分开，新增公开服务无需扩大固定白名单。

实际 SDK：

```ts
api.interop.register('author.status', 1, handlers, initialSnapshots)
await api.interop.call('author.status', 1, 'read', input, { timeoutMs: 5000 })
const unsubscribe = api.interop.subscribe('author.status', 1, 'state', snapshot => {})
api.interop.publish('author.status', 1, 'state', completeSnapshot)
```

方法接收 `(input, { caller, owner, signal })`。caller 由宿主绑定；页面 RPC 的 owner 自动传播，不从插件输入对象取值。前端调用自身 RPC，再由其后端转调公开服务；总线不自动向页面或 AI 开放。插件仍是受信任本机代码，这不是对恶意代码的隔离边界；AI 授权及目标检查仍由现有显式工具入口负责。

参数和结果均校验并复制为 JSON 对象，单次最多 256 KiB；调用默认 15 秒、可配置 1–30,000 毫秒，嵌套最多 8 层，提供者最多 64 个资源占用（含其他插件任务）。执行时持有调用者和提供者租约；超时会通知取消，但不假定底层工作停止。租约在真实工作结束后释放，因此未响应取消的工作会继续阻止热卸载。写入超时结果未知，不自动重放；写入方须自主管理持久操作 ID 和核对接口，示例的内存去重只用于演示。

状态订阅返回完整快照 `{ available, provider?, epoch?, revision, value? }`。每个主题必须提供初始快照；同一轮中的多次变化合并为最新完整状态，允许 revision 跳号，不用于可靠动作队列。提供者换代更换 epoch、缺失通知 available=false；订阅随消费者作用域释放。每插件最多 128 个订阅、每秒最多 256 次发布，异常回调不影响其他订阅。

必需依赖缺失、成环或提供者有歧义时不能提交新运行代次；可选依赖缺失仅组合功能不可用。有多个提供者时必须显式指定 provider，当前没有默认提供者配置 UI。依赖组更新一起暂存验证，失败保留旧实现；新调用不允许向等待更新的插件发起写操作。维护期间仅明确声明的 read/finish 可继续，新的资源任务仍受维护拦截。

## 启用、停用与卸载

官方随附的独立插件放在安装根目录 `plugins/<目录>/`，仍使用相同清单与 SDK，不增加具体业务的宿主分支。开发及生产入口扫描该目录，验证文件、按内容 SHA-256 缓存不可变运行包；兼容且首次出现时自动安装启用，禁止声明安装脚本。插件中心显示“官方 · 内置”。这是宿主随附来源，第三方 Git 清单不能声明自己获得此来源。

随附插件可禁用、卸载，选择跨重启和宿主更新保留。卸载后保留文件和配置，发现页可“恢复安装”，无需 Git 或网络。宿主更新仅更新仍安装的同数据版本包，保留禁用状态及兼容配置字段；数据版本变化先保留旧包并提示迁移。随附包不作为外部 Git 安装引用进入配置同步。安全恢复模式也暂停此类可卸载插件；旧固定内置核心服务保持原有行为。

可安装插件的启用状态与安装状态独立：停用保留已安装卡片及配置入口，撤销业务入口；卸载移出已安装列表并撤销页面和注册。正在使用的资源结束后再切换，期间明确显示等待，不能把提交卸载设置当成资源已释放。

卸载保留本地 releases、仓库/元数据缓存、插件 data 及公开配置保留记录，不后台删除这些文件。重装仍走固定提交的安装确认；同插件 ID、同来源、同 dataVersion 才复用保留配置，只恢复新版仍声明的同类型字段。换来源不自动交接公开配置。卸载后的插件仍可能出现在“发现插件”索引中，属于可重新安装项目。永久清理不混在卸载动作中。

历史内置服务仍使用原有固定槽和启动装配；其卡片标明“随宿主运行”，当前不把它们伪装为可独立卸载的外部包。已迁移任务管理器工具入口及配置同步/MCP 设置入口。新独立工具应采用本页注册机制；系统优化工具按独立包实现，不加入旧内置业务分支。

## 生命周期

前端导入和激活总计 15 秒、清理 5 秒；后端导入与激活也有 15 秒期限。前端加载不阻塞服务器目录初始化。超时后拒绝迟到注册；失败保留已有页面。`onDispose` 必须幂等并清理监听、定时器及连接；使用 `await api.host.acquireResource()` 声明业务资源占用，结束后释放。不要依赖插件停用去终止非插件拥有的进程。

当前验证批次、截图与尚待事项见[实施记录](plugin-platform-implementation.md)。
