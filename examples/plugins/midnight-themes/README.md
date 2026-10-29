# 午夜配色示例

本示例默认运行在共享 Worker，主线程不加载其业务。后端使用当前 `registerService(name, implementation)`，不接收 Cordis Context 或存储对象；跨插件协作使用异步 `interop`。

一个可拆到独立 Git 仓库的完整 WebNav 插件，同时替换后端配色服务和前端配色设置页。无需 npm install 或构建，Git 根目录包含 webnav.plugin.json 即可。

## 安装与验证

将本目录内容作为独立仓库根目录发布。WebNav → 插件中心 → 从 Git 安装 → 读取说明 → 确认风险并安装 → 设为默认实现，立即生效，无需重启或刷新页面。本示例使用默认 hot 生命周期，支持在线更新和禁用。

没有保存过配色时，默认采用午夜蓝；本插件已经保存的配置不会被覆盖。全局设置的配色页由插件提供。打开插件中心，选择内置「终端配色」→ 使用内置实现，即在线恢复原实现。插件监听器通过 onDispose 清理；其他包含持续连接或后台任务的插件还需要 异步 api.host.acquireResource 租约，详见宿主插件规范。

## 数据与平台

使用 v1 配色格式，保存在宿主提供的 dataDirectory 内，以临时文件和重命名提交。切回内置服务恢复内置自己的配色；本插件数据仍保留。此版本直接采用新接口，不迁移旧示例的宿主存储键。dataVersion 为 1。支持 Windows / Linux / macOS 的 x64、arm64，要求 WebNav ^0.1.2 与 Node >=22.12.0。当前示例验收使用本机测试环境，平台声明并不代表全部平台都实测。

后端通过 activate(api) 接收 SDK，registerService 声明服务，registerRpc 注册命名空间方法。前端通过 api.vue 使用宿主 Vue，不打包另一份 Vue；registerView 接管配色槽位。

## 风险

此示例展示扩展协议，第三方修改后的版本仍需自行审查。来源标记、平台检查与 AI 审核都不是安全保证。插件有当前系统用户权限。
