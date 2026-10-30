# 插件控件与界面扩展

2026-10-28 已实现。适用于内置和第三方插件，不要求继承统一父类。工具入口、设置、字体仍沿用原 SDK；菜单、标签页、面板、操作栏通过本页机制注册。

## 内置界面更新（2026-10-30）

内置插件的界面声明与注册代码同属前端构建。前端静态收集 `backend/plugins/*/webnav.plugin.json` 的公开 JSON，校验后仅使用 ID、API 版本、能力版本及 `contributes`；不导入后端实现。收到 `plugins.state/assets` 后，仅对后台确认存在且本地已注册前端的内置插件合并界面声明。API 版本及前端要求的能力版本须匹配，第三方释放包仍完全使用后台提供的资源和声明。

因此旧后台即使仍缓存更新前的菜单字段、或尚未为某个内置插件返回前端 asset，也可由新页面配套的声明注册菜单。合并不修改后台缓存、运行版本、配置、提供者、鉴权或 RPC 实现；不能用前端清单假装新增后端能力。新后端契约必须按能力版本或可选协商处理。

源码正式模式运行 `pnpm --filter @webnav/frontend build` 后刷新页面即可加载新的界面资源及声明；首页使用 `no-store`，资源文件名包含构建散列。后台保持运行，SSH 由现有会话持有机制接回同一 Shell。刷新会重建浏览器视图，不属于完全不刷新页面的组件热替换；后端代码、环境变量与不兼容的契约更新仍按服务生命周期处理。

本批验证：前端相关 17 项测试、前端类型检查与生产构建、多语言及目录一致性检查通过。浏览器用例将后台菜单声明固定为更新前版本，在两个本机模拟 SSH 存活时刷新，断言会话 ID、Shell 数量、SSH TCP 连接数量不变，两个新菜单与中英文切换均正常。日常实例另只读核对旧后台缓存与新前端合并结果，确认新构建已由原进程提供；未重启日常后台或向真实 SSH 注入命令。

## 身份、公开规则与静态目录

控件完整标识是 **插件清单 ID / 控件局部 ID**，例如 `builtin.taskManager/process-details`。中文显示名和用途说明可以更改；标识不随改名变化，不能随机生成。契约版本独立于插件包版本，参数语义发生不兼容变化时增加整数 `version`。

所有通过框架注册的控件默认公开，清单省略 `public` 等于 `true`；手动设为 `public: false` 后，只供本插件自身使用。非公开控件不出现在静态目录、`listPoints` 或 `find` 中，其他插件即使知道标识或猜到实例 ID，也不能通过框架注入内容或激活标签。插件自己的原有内容仍显示。普通 HTML / Vue 内部元素不是框架注册控件，不自动扫描 DOM 或开放修改。

其他开发者或 AI 先查 [静态扩展点表](plugin-ui-catalog.md) 或 [机器可读 JSON](plugin-ui-catalog.json)，再阅读对应声明来源。目录包含插件名称与 ID、控件名称、用途、扩展类型、契约版本、上下文字段类型 / 必填 / 含义。用途说明与每个字段说明都是必填；声明校验会拒绝缺失内容。

目录读取 `webnav.plugin.json`，不加载插件代码、不需要运行页面：

```powershell
pnpm --filter @webnav/shared build
pnpm plugins:catalog
pnpm plugins:catalog:check
# 只扫描指定插件目录，输出 JSON 到标准输出，不修改项目目录：
node scripts/plugin-ui-catalog.mjs examples/plugins
```

仓库目录由内置插件、随附插件和独立示例清单生成。第三方插件以自己发布的清单提供相同的静态契约，不需要登记进宿主白名单。静态声明不表示当前已安装、已启用或界面已挂载。

## 声明与注册

以下是一个独立插件开放标签控件的清单片段；完整可运行示例见 [界面扩展示例](../examples/plugins/ui-extension-host/README.md)。每插件菜单位置与 UI 位置各最多 16 个，局部 ID 不能跨两类重复，每类贡献最多 64 项。

```json
{
  "contributes": {
    "uiPoints": [{
      "id": "details",
      "title": "项目详情",
      "description": "当前选中项目的详情区，可增加分析标签。",
      "kind": "tabs",
      "version": 1,
      "fields": {
        "itemId": { "type": "string", "required": true, "description": "当前项目 ID" }
      }
    }]
  }
}
```

`activate(api)` 中调用 `api.ui.registerPoint('details')`。渲染 `api.ui.Slot` 时，传 `point/context/isCurrent`，框架自动登记实例，卸载时自动注销；无需手动管理实例表。`kind` 支持：

| 类型 | 自身内容 | 外部内容 |
| --- | --- | --- |
| `tabs` | `items: [{id,label}]` 与默认 slot | 扩展标签及组件 |
| `panel` | 默认 slot | 带标题、插件来源的面板 |
| `actions` | 默认 slot | 工具栏按钮等组件 |
| `menu` | `items` 与 `execute(id)` | 声明的操作项 |

`tabs/panel/actions` 写入 `uiPoints`；`menu` 写入 `menuPoints`，不用填写 `kind`，通过 `api.menus.registerPoint(id)` 注册，再渲染 `api.menus.ContextMenu`。菜单组件额外接受 `x/y`、可选 `owner: Document`、`label`，发出 `close`。它处理定位、键盘、点击外部关闭以及来源标签；宿主原有菜单项目也走同一执行校验。

`Slot` 的 `tabs` 支持 `active` 和 `update:active`，默认 slot 接收 `{ active }`；命名 slot `actions` 用于自身的标签栏操作按钮。公开贡献组件接收只读 `context` 和 `active`；当前实现切换标签会卸载旧扩展内容，切换上下文或插件代次也重新挂载。需要跨标签保留状态的插件自己管理有界状态并在 `onDispose` 清理。

`isCurrent()` 必须检查当前对象仍存在、所属页面 / 目标有效；框架同时核对声明、上下文签名、宿主连接状态和插件运行代次。上下文只允许声明过的扁平字符串、有限数字和布尔值：最多 32 字段、每字符串 4096 字符、序列化后 16384 字符。不要传 DOM、函数、凭据、终端正文或其他业务秘密。

## 向另一插件添加内容

菜单写入 `contributes.menuItems`，界面组件写入 `contributes.uiItems`。目标明确指定插件 ID、控件局部 ID、契约版本。无需修改宿主，也无需修改被扩展插件；前提是目标已公开支持该类型的控件。

```json
{
  "contributes": {
    "menuItems": [{
      "id": "inspect", "title": "打开扩展诊断",
      "target": { "plugin": "builtin.taskManager", "point": "process", "version": 1 },
      "access": "read", "group": "diagnostics", "order": 500
    }],
    "uiItems": [{
      "id": "process-details", "title": "扩展诊断",
      "target": { "plugin": "builtin.taskManager", "point": "process-details", "version": 1 },
      "order": 500
    }]
  }
}
```

```js
export function activate(api) {
  api.ui.registerItem('process-details', { component: ProcessDiagnostics })
  api.menus.registerItem('inspect', {
    when: context => context.startedAt > 0,
    enabled: context => context.targetKind === 'local',
    run(context, { signal }) {
      if (signal.aborted) return
      const keys = ['monitorId', 'bootId', 'targetKind', 'serverId', 'connectionId', 'pid', 'startedAt']
      const instance = api.ui.find({ plugin: 'builtin.taskManager', point: 'process-details' })
        .find(instance => keys.every(key => instance.context[key] === context[key]))
      if (!instance || !api.ui.activate(instance.id, 'process-details')) {
        throw new Error('目标已变化，请重新选择进程。')
      }
    }
  })
}
```

完整可运行示例见 [进程诊断示例](../examples/plugins/process-inspector/README.md)，它还向另一个示例插件的全部四种控件贡献内容。`when` 决定是否展示，`enabled` 决定菜单是否可点击；异常只影响该项。排序按 `order`（默认 500）及稳定标识，菜单按 `group` 加分隔线，框架绑定来源名称与插件 ID。菜单 `access: read/write` 和 `danger` 描述操作性质，不授予系统权限，也不替代业务确认。

## 查找的是公开契约或当前实例

| API | 返回 / 行为 |
| --- | --- |
| `api.ui.listPoints({plugin?,point?,kind?})` | 当前运行插件的公开声明、说明和字段，不要求控件已经显示 |
| `api.ui.find({plugin?,point?,kind?})` | 当前有效的公开实例描述，包括临时实例 ID 与只读上下文 |
| `api.ui.activate(instanceId, ownItemId)` | 在一个仍有效的标签控件上激活调用插件自己的贡献；成功为 `true` |

同一控件可存在多个实例，例如不同会话或进程详情。实例 ID 临时且不复用，不能存入用户配置；先按控件完整标识找到候选，再核对业务上下文。`find` 不返回 DOM / Vue 引用，不能修改其他插件内部状态或跳过其业务接口。`activate` 仅选中已挂载区域中的自身标签，不会打开被关闭的工具或启动业务任务。当前每页最多登记 128 个控件实例。

## 生命周期与业务边界

- 声明和注册在前端激活期间暂存，全部完成后一起发布；未声明、重复、迟到或缺少注册会失败。更新候选失败保留旧运行视图与扩展。
- 未安装、未运行、非公开或版本不匹配的目标不会显示该扩展；它是可选组合，不阻塞插件其他功能。
- 插件禁用、卸载或更新后撤销对应内容；正在打开的旧目标菜单失效，已移除的标签回到第一个可用标签。Vue 子树卸载，贡献组件的渲染异常限制在该内容区域。
- 菜单点击再次核对上下文、代次、可用条件。正在执行的同一项目禁止重复点击，每插件最多 8 个未完成动作。贡献方或目标方被撤下、宿主锁定 / 断线时发出取消信号；15 秒后报告结果未明，不自动重试。清理等待真实 Promise 结束，超过现有前端 5 秒清理限额会明确提示未完成。取消不能假定底层系统动作已经停止。
- 菜单关闭并不取消已点击操作。涉及目标的异步动作必须在自己的后端再次验证身份并处理迟到结果；前端上下文校验不能代替它。长任务、监听与连接继续遵守 SDK 的 `onDispose`、后端资源租约和 WS 契约。
- 插件是受信任本机代码；`public` 是框架扩展规则，不是抵御恶意 JavaScript / CSS 的隔离环境。插件开发应遵守公开规则，不操作其他插件内部 DOM。

任务管理器已开放 `process` 菜单与 `process-details` 标签；终端、AI 终端、SSH 文件和工作区标签菜单均接入同一机制。远程桌面 / 设备里的右键仍转发给远端，不替换为插件菜单。

## 调试插件的接法

OllyDbg 等调试插件可以声明上述菜单和标签贡献，把菜单标题改为“调试此进程”，由自身后端完成调试器准备、权限判断、附加 / 脱离与会话管理。必须核对 monitorId 对应的实际目标和用户、bootId、PID、startedAt，并另行检测进程架构；上下文 `arch` 只是采集器架构，不能当作进程位数。未知创建时间不应放行附加。调试器真实系统支持范围必须按实际实现验证。

本次仅实现框架与不执行系统操作的示例，没有安装调试器、启动调试会话或对真实进程附加。

## 本批验证（2026-10-28）

- `frontend/tests/plugin-ui.test.mjs`：10/10，覆盖默认公开、私有阻断、声明校验、暂存发布、原有与外部菜单统一校验、旧代次 / PID 复用、取消与真实完成、错误隔离、实例查找与注销；与现有任务管理器 / 历史单元测试同批执行，共 20/20。
- `backend/tests/plugin-platform.test.mjs`：4/4，已有独立 Git 安装、服务通信和清理回归。
- `backend/tests/plugin-ui-browser.mjs`：隔离包＋本机模拟 SSH / SFTP / 采集器，验证任务管理器及其他四类现有菜单、独立插件全部四种 UI 扩展、来源、跨进程切换、禁用 / 重新启用 / 卸载、渲染错误隔离、浅色 / 深色 / 390px。
- `backend/tests/plugin-platform-browser.mjs`：已有独立工具、共享设置草稿、字体、服务调用、停用设置与卸载回归通过。
- `backend/tests/task-manager-selection-browser.mjs`：原有选择 / 冻结排序 / 清除 / 菜单 / 身份校验回归通过。
- shared 构建、前后端类型检查与生产构建通过；静态目录一致性及本文 / 目录共 19 个相对文档链接检查通过。前端构建仍报告既有 JMuxer `stream` 外置与大块提示。

截图：[任务管理器扩展](design/screenshots/plugin-ui-process-extension.png)、[独立插件互相扩展](design/screenshots/plugin-ui-cross-plugin.png)、[深色窄屏](design/screenshots/plugin-ui-mobile-dark.png)。所有示例和测试数据位于隔离目录，不注入用户运行目录。
