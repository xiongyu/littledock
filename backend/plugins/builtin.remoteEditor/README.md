# 远程 VS Code

为当前 SSH 目录打开独立远端编辑器，缓存安装包，通过 SSH 转发访问 Linux / Windows 的网页编辑器。

## 功能与边界

Linux 使用 code-server，Windows 使用 VS Code Server Web。安装远端组件需用户确认，首次下载后本机缓存，支持预缓存离线包。网页编辑器通过回环代理访问。

## 平台与依赖

运行 WebNav 的宿主平台：win32 / x64、win32 / arm64、linux / x64、linux / arm64、darwin / x64、darwin / arm64。平台声明用于兼容筛选，不等于对每个平台都完成了真实远端验收。

依赖：sshFiles、sessions、credentials、auth。

## 替换与恢复

公开能力：`service:remoteEditor@1`。第三方实现需遵循 [插件规范](../../../docs/plugins.md) 中的服务契约、数据格式和清理要求。插件中心选择提供者，默认在线生效。相关任务或连接使用中时等待结束后自动切换；无法在线替换时显示待重启及原因。

此内置插件随 WebNav 发布，说明和图标从当前安装目录读取，无需访问远程仓库。恢复内置实现不自动迁移或回滚第三方已改写的数据。

