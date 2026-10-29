# 安装与运行

[返回项目首页](../README.md) · [文档导航](README.md)

## 获取源码

```powershell
git clone https://github.com/xiongyu/littledock.git
cd littledock
```

## 启动工作台

已验证 Node.js 24.16.0、pnpm 12.4.2。首次运行：

~~~powershell
pnpm install
pnpm build
pnpm start
~~~

打开 http://127.0.0.1:3030/ ，导航页面自动连接本机服务，无需配对。没有设置主密码时直接进入；设置了主密码且尚未解锁时输入主密码。独立浏览器自动填写扩展需单独安装、首次配对并按网站授权。

开发只需运行一次：

~~~powershell
pnpm dev
~~~

根目录与 `frontend/` 下的 `pnpm dev` 都会启动前后端（`npm run dev` 调用同一入口）。Windows 上就绪后命令返回，右下角显示小站托盘，此时可以关闭终端；右键提供“打开主页 / 开机启动 / 重启 / 退出”，双击也可打开主页。开机启动默认关闭，勾选后在用户登录时生效。直接打开 http://127.0.0.1:5173/ ，管理中心地址为 /#manage，插件中心地址为 /#plugins。

更新小站宿主后端代码或启动环境变量后，从托盘选择“重启”；生产模式先重新 `pnpm build`。数据库保留，活动网页连接会断开。插件中心的安装、启停和更新默认在线生效，只有界面明确显示“待重启”时才需要稍后重启；相关资源使用中则等待结束后自动切换。升级宿主本身仍需重启，不能由插件热更新代替。

重复运行 `dev`、`start` 或 console 命令会自动打开现有实例的实际网址，不创建另一套服务；更换仓库目录、端口或 `WEBNAV_DATA_DIR` 也不绕过此限制。需要切换参数时先退出再启动。本次单实例启动器升级需完整退出旧工作台后重新启动。

正式运行的 `pnpm start` 同样使用托盘，退出也从托盘操作。首次从旧版终端运行迁移时先关闭旧服务，避免端口占用。需要前台日志时用 `pnpm dev:console` / `pnpm start:console`，Ctrl+C 退出；非 Windows 默认前台运行。详细说明见[Windows 托盘](windows-tray.md)。`pnpm dev:ui` 仅用于已有后端的前端单独调试。

数据未加载时显示“目录尚未加载”，不显示 0 台或“还没有服务器”；连接中断时保留本页上次读取的目录，并暂停目录操作。浏览器缓存不是数据库；Windows 默认目录数据库为 `%LOCALAPPDATA%/WebNav/webnav.sqlite`，与从哪个代码目录启动无关。

~~~powershell
pnpm typecheck
pnpm test
pnpm build
~~~

类型检查与构建覆盖四个工作区；`pnpm test` 先构建 shared，再运行 backend、frontend 和 extension 测试。shared 当前没有独立测试脚本，浏览器验收脚本需按对应功能文档单独运行。

Windows 数据默认在 `%LOCALAPPDATA%/WebNav/`；没有 LOCALAPPDATA 时使用 `~/.local/share/WebNav/`，可用 `WEBNAV_DATA_DIR` 改变。`WEBNAV_PORT` 默认 3030，`WEBNAV_UI_PORT` 为开发页面端口，默认 5173。生产静态资源与业务 WS 同源，服务器只监听 127.0.0.1。第三方插件导致启动异常时，可设置 `WEBNAV_DISABLE_PLUGINS=1` 后重新启动，以内置实现恢复访问；安装记录、配置和插件数据仍保留。

## 第一次使用

1. 点击右上角加号，添加服务器及 SSH / RDP / VNC 等连接入口，或从管理中心预览并导入本机 SSH 配置。
2. 在「网页收藏」添加常用网站；在右上角外观设置选择主题、语言或背景视频。
3. 如需加密保存的凭据，在全局设置中设置主密码。

初始目录为空。README 中的演示服务器和网站不会随安装写入你的数据。当前主要验收平台为 Windows x64；其他平台及各连接能力的实际范围见[验收记录](validation-history.md)与对应功能文档。

## 可选组件

- 任务管理器：源码运行前按[采集器构建说明](../backend/native/task-manager/README.md)准备 Go 环境，执行 `pnpm collector:build`；远程安装由用户在插件内触发。
- 浏览器扩展：构建后可从全局设置获取安装包，首次使用需独立配对，详见[浏览器扩展](browser-extension.md)。
- 远程编辑器：目标首次安装、许可与缓存方式见[远程 VS Code](remote-editor.md)。
- 正式版制作与更新：见[发布说明](online-updates.md)。GitHub 当前尚无正式发行包，先使用源码入口。
