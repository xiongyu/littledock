# 前端

Vue 3、Vite、TypeScript。导航、管理、固定宽度卡片和皮肤布局保留；目录由业务 WS 同步并保存到后端 SQLite，初始为空，示例只存在 tests/fixtures/。

根目录或本目录运行 `npm run dev` / `pnpm dev` 即同时启动前后端，直接打开 5173。开发页面响应自动建立 HttpOnly 本机会话，无配对操作；`dev:ui` 只供已有后端时单独调试。未加载目录与真实空目录分别显示；断开时保留已加载列表并暂停操作。只打开静态 preview 无法提供业务服务。

## 代码入口

- src/App.vue：导航、编辑抽屉、终端标签与弹窗。
- src/backend.ts：单个业务 WS、自动会话恢复、请求匹配、超时、重连、目录版本与快照。
- components/ManagementPage.vue：目录 CRUD、分组、批量操作、WS 导入预览与导出。
- components/ServerEditor.vue：编辑草稿；保存已有 SSH 入口后可进入认证设置、查看历史。
- components/VaultPanel.vue：右上角全局设置，主密码与解锁有效期；VaultUnlock.vue：页面统一解锁，刷新和新标签共用后端有效期。CredentialPanel.vue 只负责 SSH 认证信息，不包含单独的保存方式设置。秘密不进入浏览器持久存储。
- components/TerminalPane.vue：按需加载 xterm.js，2,000 行 scrollback，独立终端 WS；write 回调后累计 ACK，隐藏标签仍解析，关闭释放。
- components/WorkspaceTabs.vue、TerminalWindow.vue：默认整块右侧终端、自适应标签、多窗口悬浮与拖动缩放，收回时复用现有连接。
- components/HistoryPanel.vue：独立只读对话框，固定范围查询、搜索、刷新和分页；只保留当前页与最多 100 个游标。
- src/catalog.ts、catalog-management.ts：转导出 shared/ 的公开 DTO 和运行时校验。
- src/appearance.ts、styles.css：外观、左右独立背景与语义 CSS 变量；外观仅保存在当前浏览器。

卡片右侧 88×88 圆角正方形目前仍为画面占位；没有接入真实截图。首版最近使用仅本页保留，不恢复 Shell。RDP 密码随配置事务保存，启动时交接给 Windows 客户端。

pnpm --filter @webnav/frontend test 运行 24 项目录、弹窗和预览规则测试。后端集成测试及浏览器验证范围见[根 README](../README.md)。
