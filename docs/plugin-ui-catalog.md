# 插件公开扩展点目录

由 `pnpm plugins:catalog` 从清单生成；不要手工编辑本文件。机器可读版本：[plugin-ui-catalog.json](plugin-ui-catalog.json)。开发规则见 [plugin-ui-extensions.md](plugin-ui-extensions.md)。示例插件仅是开发参考，不自动安装。

标识格式为 `插件 ID/控件局部 ID`；显示名称可更改，标识不得随显示名称变化。下表是静态契约；位置存在于清单不表示已安装、已启用或界面已挂载。

| 完整标识 | 名称 / 来源 | 类型 | 版本 | 用途 |
| --- | --- | --- | --- | --- |
| `builtin.mcp/terminal` | AI 终端菜单 / MCP 工作台接入 | menu | 1 | AI 工作终端内容菜单；人工控制权限变化会使当前菜单失效。 |
| `builtin.sessions/terminal` | 终端右键菜单 / SSH 终端 | menu | 1 | SSH / 本地终端的内容菜单。仅传会话元数据，不公开终端输出或剪贴板正文。 |
| `builtin.sessions/workspace` | 工作区标签菜单 / SSH 终端 | menu | 1 | 连接工作区主标签和分屏标题菜单。groupId 非空表示整组菜单。 |
| `builtin.sshFiles/entry` | SSH 文件菜单 / SSH 文件管理 | menu | 1 | SSH 文件项或当前目录的操作菜单。路径属于指定会话；写入仍需后端校验版本及权限。 |
| `builtin.taskManager/process` | 进程右键菜单 / 任务管理器 | menu | 1 | 选中进程的操作菜单。可添加诊断、调试入口；操作前必须核对完整目标和进程身份。 |
| `builtin.taskManager/process-details` | 进程详情 / 任务管理器 | tabs | 1 | 当前选中进程的详情标签区。可添加调试、诊断、分析标签；切换目标或进程时旧实例失效。 |
| `example.ui-extension-host/actions` | 示例操作栏 / 界面扩展示例 | actions | 1 | 示例操作栏，用于演示独立插件向其他插件开放扩展位置。 |
| `example.ui-extension-host/details` | 示例详情标签 / 界面扩展示例 | tabs | 1 | 示例详情标签，用于演示独立插件向其他插件开放扩展位置。 |
| `example.ui-extension-host/item` | 示例项目菜单 / 界面扩展示例 | menu | 1 | 示例项目菜单，用于演示独立插件向其他插件开放扩展位置。 |
| `example.ui-extension-host/summary` | 示例摘要面板 / 界面扩展示例 | panel | 1 | 示例摘要面板，用于演示独立插件向其他插件开放扩展位置。 |

## builtin.mcp/terminal

AI 工作终端内容菜单；人工控制权限变化会使当前菜单失效。

[声明来源](../backend/plugins/builtin.mcp/webnav.plugin.json) · 插件版本 0.1.0 · 契约版本 1

| 字段 | 类型 | 必填 | 含义 |
| --- | --- | --- | --- |
| `sessionId` | string | 是 | 当前 AI 终端会话 ID |
| `connected` | boolean | 是 | 观察通道是否已连接 |
| `writable` | boolean | 是 | 当前人工是否持有输入权 |
| `hasSelection` | boolean | 是 | 是否选中文本，不包含正文 |

## builtin.sessions/terminal

SSH / 本地终端的内容菜单。仅传会话元数据，不公开终端输出或剪贴板正文。

[声明来源](../backend/plugins/builtin.sessions/webnav.plugin.json) · 插件版本 0.1.0 · 契约版本 1

| 字段 | 类型 | 必填 | 含义 |
| --- | --- | --- | --- |
| `sessionId` | string | 是 | 当前终端会话 ID |
| `ready` | boolean | 是 | 终端是否就绪 |
| `hasSelection` | boolean | 是 | 是否选中文本，不包含正文 |

## builtin.sessions/workspace

连接工作区主标签和分屏标题菜单。groupId 非空表示整组菜单。

[声明来源](../backend/plugins/builtin.sessions/webnav.plugin.json) · 插件版本 0.1.0 · 契约版本 1

| 字段 | 类型 | 必填 | 含义 |
| --- | --- | --- | --- |
| `sessionId` | string | 是 | 当前会话 ID |
| `protocol` | string | 是 | 会话协议 |
| `groupId` | string | 是 | 分屏组 ID，无则为空 |

## builtin.sshFiles/entry

SSH 文件项或当前目录的操作菜单。路径属于指定会话；写入仍需后端校验版本及权限。

[声明来源](../backend/plugins/builtin.sshFiles/webnav.plugin.json) · 插件版本 0.1.0 · 契约版本 1

| 字段 | 类型 | 必填 | 含义 |
| --- | --- | --- | --- |
| `sessionId` | string | 是 | 所属 SSH 会话 ID |
| `path` | string | 是 | 所选项或当前目录的远端完整路径 |
| `name` | string | 是 | 所选项名称，目录空白处为空 |
| `kind` | string | 是 | file、directory、link 或其他文件类型 |

## builtin.taskManager/process

选中进程的操作菜单。可添加诊断、调试入口；操作前必须核对完整目标和进程身份。

[声明来源](../backend/plugins/builtin.taskManager/webnav.plugin.json) · 插件版本 0.4.0 · 契约版本 1

| 字段 | 类型 | 必填 | 含义 |
| --- | --- | --- | --- |
| `monitorId` | string | 是 | 当前监控连接 ID，绑定目标与用户 |
| `bootId` | string | 是 | 目标系统启动标识 |
| `targetKind` | string | 是 | local 或 ssh |
| `serverId` | string | 否 | SSH 目标服务器 ID |
| `connectionId` | string | 否 | SSH 连接入口 ID |
| `platform` | string | 是 | 目标 OS：win32、linux、darwin |
| `arch` | string | 是 | 采集器架构：x64 或 arm64；不是被观察进程的位数 |
| `pid` | number | 是 | 进程 PID，不能单独用作进程身份 |
| `startedAt` | number | 是 | 进程创建时间，与启动标识和 PID 一同核对；0 表示未知 |
| `name` | string | 是 | 进程显示名称 |
| `executable` | string | 否 | 可访问时的可执行文件路径 |

## builtin.taskManager/process-details

当前选中进程的详情标签区。可添加调试、诊断、分析标签；切换目标或进程时旧实例失效。

[声明来源](../backend/plugins/builtin.taskManager/webnav.plugin.json) · 插件版本 0.4.0 · 契约版本 1

| 字段 | 类型 | 必填 | 含义 |
| --- | --- | --- | --- |
| `monitorId` | string | 是 | 当前监控连接 ID，绑定目标与用户 |
| `bootId` | string | 是 | 目标系统启动标识 |
| `targetKind` | string | 是 | local 或 ssh |
| `serverId` | string | 否 | SSH 目标服务器 ID |
| `connectionId` | string | 否 | SSH 连接入口 ID |
| `platform` | string | 是 | 目标 OS：win32、linux、darwin |
| `arch` | string | 是 | 采集器架构：x64 或 arm64；不是被观察进程的位数 |
| `pid` | number | 是 | 进程 PID，不能单独用作进程身份 |
| `startedAt` | number | 是 | 进程创建时间，与启动标识和 PID 一同核对；0 表示未知 |
| `name` | string | 是 | 进程显示名称 |
| `executable` | string | 否 | 可访问时的可执行文件路径 |

## example.ui-extension-host/actions

示例操作栏，用于演示独立插件向其他插件开放扩展位置。

[声明来源](../examples/plugins/ui-extension-host/webnav.plugin.json) · 插件版本 1.0.0 · 契约版本 1

| 字段 | 类型 | 必填 | 含义 |
| --- | --- | --- | --- |
| `itemId` | string | 是 | 当前示例项目标识 |

## example.ui-extension-host/details

示例详情标签，用于演示独立插件向其他插件开放扩展位置。

[声明来源](../examples/plugins/ui-extension-host/webnav.plugin.json) · 插件版本 1.0.0 · 契约版本 1

| 字段 | 类型 | 必填 | 含义 |
| --- | --- | --- | --- |
| `itemId` | string | 是 | 当前示例项目标识 |

## example.ui-extension-host/item

示例项目菜单，用于演示独立插件向其他插件开放扩展位置。

[声明来源](../examples/plugins/ui-extension-host/webnav.plugin.json) · 插件版本 1.0.0 · 契约版本 1

| 字段 | 类型 | 必填 | 含义 |
| --- | --- | --- | --- |
| `itemId` | string | 是 | 当前示例项目标识 |

## example.ui-extension-host/summary

示例摘要面板，用于演示独立插件向其他插件开放扩展位置。

[声明来源](../examples/plugins/ui-extension-host/webnav.plugin.json) · 插件版本 1.0.0 · 契约版本 1

| 字段 | 类型 | 必填 | 含义 |
| --- | --- | --- | --- |
| `itemId` | string | 是 | 当前示例项目标识 |
