# README 展示图

日期：2026-10-29。图片来自当前构建的真实界面，使用独立临时数据库、独立浏览器上下文与本机模拟服务。没有读取、改名或连接用户的真实服务器或设备。

## 当前图片

| 图片 | 展示内容 |
| --- | --- |
| [主页](images/overview.png) | 水獭品牌、晨雾背景、示例网站和 9 台演示服务器 |
| [深色主页](images/overview-dark.png) | 同一目录切换为暮色归港 |
| [SSH 工作区](images/ssh-workspace.png) | 两条本机模拟 SSH 的左右分屏、系统信息与真实 SFTP 交互 |
| [RDP 工作区](images/rdp-workspace.png) | 当前桌面组件、显示通道与示例桌面；不代表真实 Windows 登录验收 |
| [VNC 工作区](images/vnc-workspace.png) | 本机 RFB 模拟服务通过 noVNC 显示示例桌面 |
| [安卓设备](images/android-workspace.png) | 实际 ADB PNG 渲染与控制入口；底层命令替换为只读示例画面，不连接手机 |
| [任务管理器](images/task-manager.png) | 当前进程表、资源占用与进程详情，数据来自 UI 测试夹具 |
| [性能曲线](images/task-manager-performance.png) | 当前 CPU 性能页，以有界模拟采样展示曲线 |
| [插件中心](images/plugins.png) | 当前内置插件列表；没有拉取或执行第三方插件 |

所有图统一采用已选定的水獭完整形象，侧栏显示 72px 图像和圆角底板。截图入口检查资源地址、显示尺寸与「小站」字标，不能复用早期 W / WebNav 标志的截图。

## 演示信息

- 服务器名称使用「开发服务器」「家庭 NAS」「测试工作站」等通用名称。
- 主页地址使用 `192.0.2.x`、`198.51.100.x`、`203.0.113.x` 文档示例网段；这些条目不发起远程连接。
- SSH 截图只连接动态端口上的 `127.0.0.1` 测试服务。`demo`、`fixture`、`atlas-dev` 与终端命令输出均由脚本生成，不来自真实机器。
- 三张网站卡片来自本地渲染的演示 HTML，地址为 `*.example.com`，不会访问外部网站。它们用于展示网页收藏的缩略图能力。
- 系统信息与终端输出为模拟内容，不代表真实服务器运行情况或性能测量。SFTP 使用临时文件，截图后随测试服务一起清理。
- RDP、VNC 和安卓的内层画面由 `scripts/readme-demo-peers.mjs` 渲染示例 HTML，画面内明确标注「演示」。它们经当前显示通道呈现，不是操作系统或真实手机截图，也不是跨平台验收证据。RDP 在隔离服务中替换本机助手输出，VNC 使用回环 RFB，安卓使用实际 PNG 提供者搭配合成命令结果。
- 任务管理器复用隔离 UI 夹具，示例进程改用 `node.exe` 等通用名称、`demo` 用户及 `C:/Demo/` 路径。没有安装采集器、结束实际进程或开启后台持续记录。

## 重拍

安装依赖并准备前端构建后，在仓库根目录运行：

```powershell
pnpm build
node --experimental-strip-types scripts/capture-readme.mjs
```

需要本机 Edge 或 Chrome。脚本只写入 `docs/images/` 中上述九张截图，其余目录数据保存在临时目录，正常结束时清理。它不使用日常实例、用户浏览器配置、已保存服务器或系统优化写入。

## README 结构参考

本轮查看了 [Tabby](https://github.com/Eugeny/tabby/blob/master/README.md)、[Homepage](https://github.com/gethomepage/homepage/blob/main/README.md) 与 [Termix](https://github.com/Termix-SSH/Termix) 的 README。采用「品牌与一句话定位 → 界面 → 少量功能 → 启动 → 文档入口」的组织方式；文案与界面图均为小站自身内容。

## 本批检查

- 截图脚本检查水獭资源、72px 尺寸、中文字标、两个可见终端及桌面/设备显示状态，并断言任务管理器没有安装、进程操作或持续记录写入。
- 九张截图已由隔离 Edge 生成并逐张检查；插件中心的水獭和 LittleDock 副标也由脚本核对。
- 六份 README / 配套文档共 122 处本地链接通过存在性检查；Markdown 预览中的 10 张图片（含品牌图）加载正常，四张功能图并排展示，390px 页面及展开区域无横向溢出。差异格式和两个截图脚本语法检查通过。
- 产品界面仅补齐插件中心遗漏的水獭标志与 LittleDock 字样，不改业务逻辑；前端类型检查、生产构建和本批 73 项前端测试通过。构建保留已有 jmuxer `stream` 外置与大分块提示。全量后端连接测试没有重跑。
