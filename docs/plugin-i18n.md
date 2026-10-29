# 插件多语言

宿主提供语言服务，插件作者随包维护翻译。当前界面默认 `zh-CN`，右上角外观设置可选择 English。偏好只保存在当前浏览器，其他同源页面通过存储事件同步。切换语言不会重新激活插件、创建 Worker、重载工具组件或重连终端。使用新服务的插件声明 `webnav: "^0.1.3"`。

## 文件与清单

内置插件、随附系统优化插件和独立示例都在自己的目录提供 `locales/zh-CN.json` 与 `locales/en.json`。宿主通用导航与表单使用 `frontend/src/locales/`，不替第三方插件保存业务翻译。

```json
{
  "i18n": {
    "defaultLocale": "zh-CN",
    "locales": {
      "zh-CN": "locales/zh-CN.json",
      "en": "locales/en.json"
    }
  }
}
```

词典是平铺字符串映射。新键建议用 `scan.start`、`errors.itemChanged` 等业务名称；存量迁移的 `m…` 也是固定消息 ID，发布后保持稳定，不在运行时根据中文计算。

```json
{
  "metadata.name": "示例工具",
  "tools.main.title": "示例工具",
  "scan.start": "开始扫描",
  "errors.itemChanged": "{name} 已变化，请重新扫描。"
}
```

英文使用相同键及参数，例如 `"errors.itemChanged": "{name} has changed. Scan again."`。翻译完整句子，避免拼接词语片段。当前仓库要求中英文键完整对应。其他语言可暂缺条目，运行时依次查找所选语言、主语言、插件默认语言；完全缺失时显示键，结构化错误保留原诊断作为兜底。

清单中文原文用于未加载词典时的显示。宿主自动查找这些固定键：

| 清单字段 | 词典键 |
| --- | --- |
| 名称、简介 | `metadata.name`、`metadata.description` |
| 工具标题 | `tools.<id>.title` |
| 配置字段 | `configFields.<key>.label` |
| 设置标题 | `settings.title` |
| 字体名称、分组 | `fonts.<flag>.name`、`fonts.<flag>.group` |
| 菜单与界面扩展标题 | `menuItems.<id>.title`、`uiItems.<id>.title`、`menuPoints.<id>.title`、`uiPoints.<id>.title` |

用户填写的服务器名称、路径、文件内容、应用名称、进程名称和终端输出保持原文，不进行文本猜测或 DOM 替换。README、控件目录等开发文档不随页面语言切换。

## 前端 SDK

业务与设置入口均提供绑定插件命名空间的 `api.i18n`：

```ts
export function activate(api: PluginFrontendApi) {
  const { h } = api.vue
  api.registerTool('main', {
    component: { setup: () => () => h('button', api.i18n.t('scan.start')) },
  })
}
```

- `t(key, params?)`：纯文本和命名参数插值；禁止把结果交给 `innerHTML` / `v-html`。
- `locale`：只读响应式语言。在渲染函数、`computed` 或 getter 中调用 `t`，不要把翻译在初始化时固定为普通字符串。
- `number(value, options?)`、`date(value, options?)`：按当前语言进行 `Intl` 格式化。
- `message(value, fallback?)`：解析后端 `MessageRef`，普通字符串保持原样。
- `ref(key, params?)`：创建本插件的消息引用。通知可保存引用，在模板中用 `message` 渲染，切换语言后会重新翻译。

禁止用翻译结果作连接状态、业务 ID、比较条件或操作去重依据。不要为换语言改变组件 `key` 或重新调用 `activate`。首版没有 ICU 复数、富文本或自动机器翻译。已产生且仅保存为字符串的通知保持产生时的语言；需要实时更新的状态应保留消息引用，在渲染时调用 `message`。

## Worker SDK

共享与独占 Worker 均提供 `api.i18n`：

```ts
throw api.i18n.error('CONFLICT', 'errors.itemChanged', { name: 'Example' })
const status = api.i18n.message('scan.start')
const defaultText = api.i18n.text('scan.start') // 日志或非 UI 调用的默认语言文本
```

`MessageRef` 包含 `namespace`、`key` 和可选标量参数，不包含函数或 HTML。Worker RPC 保留结构化错误，浏览器按本地偏好解析。插件后台任务捕获错误时同时保存 `api.shared.errorMessageRef(cause)`；只保存 `error.message` 会丢失翻译标识。系统优化插件提供了实际用法。

底层系统、第三方服务和旧服务契约的原始错误仍保留原文，不自动猜测对应翻译。新增插件界面错误使用结构化接口。

## 装载、回收与检查

`plugins.locales` 通过已鉴权业务 WS 按插件 ID 和提交读取静态 JSON，不导入业务入口。安装及随附发现先校验词典：文件位于插件释放目录，单文件最多 512 KiB、合计 1 MiB，最多 32 种语言、每词典 10,000 条。越界路径、危险对象键、额外键和参数不一致均拒绝。

停用业务仍保留设置及元数据词典，关闭设置页不会删除词典。卸载撤销命名空间；更新按提交替换，校验或前端激活失败保留前一份可用词典，旧代清理不能移除新代。内置词典构建时静态收集，只导入 JSON，不导入后端实现。

```sh
pnpm i18n:generate
pnpm i18n:check
pnpm plugins:catalog
pnpm plugins:catalog:check
```

生成命令补清单键、收集内置词典并生成键类型，不生成英文翻译。检查已接入正式构建，覆盖当前包声明、英文完整性、参数一致性、前端静态键引用和未包装的中文 UI 文本；动态业务文案及外部数据仍需人工审查。

测试入口为 `frontend/tests/i18n.test.mjs`、`backend/tests/plugin-locales.test.mjs`、`backend/tests/plugin-locales-browser.mjs`。使用隔离目录、模拟系统优化适配器、模拟任务管理器和本机 SSH，不修改日常系统。

## 本次验收（2026-10-29）

- 当前 24 个内置、随附及示例插件均携带默认中文和英文词典，加上宿主共 25 组；静态检查覆盖 99 个界面源文件。语言包检查和公开扩展点目录检查通过。
- `pnpm typecheck`、`pnpm build` 通过；最终 `pnpm test` 后端 203/203、前端 73/73、扩展 2/2 通过，无跳过。较早全量批次出现过一次托盘重启等待超时，托盘专项 5/5 和最终全量重跑均通过。
- 隔离 Edge 验证默认中文、英文切换、系统优化规则和已生成消息实时翻译、插件页面实例不变、设置草稿保留、停用后的设置页面、浏览器偏好恢复及 390px 布局。任务管理器保持原监控连接；本机 SSH 保留原终端与 Shell 并可继续输入；本机模拟 VNC 保留原画布及连接，切换后的断开状态正常。
- 本次范围为网页宿主及插件界面、插件消息契约；系统和第三方原始诊断、用户内容及终端输出保持原文。浏览器扩展弹窗和 Windows 托盘未新增语言切换。未连接真实远端、修改日常系统设置或重启日常实例。
