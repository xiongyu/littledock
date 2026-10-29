# 系统优化插件设计提示词

日期：2026-10-28。工具：内置 imagegen，非 CLI。最终图采用现有 WebNav 宿主布局；旧版独立导航及左下角返回按钮已弃用。

接入约束：图中入口和标签由插件通过通用工具注册后生成，不代表在框架硬编码系统优化按钮。此调整不改变可见布局，无需重绘；以下保留生成图片时使用的原始提示词。

## 总览图

输出：[system-optimizer-overview.png](system-optimizer-overview.png)。参考一为仓库内已实现的 [任务管理器截图](screenshots/task-manager-processes-implemented.png)，参考二为本轮早期卡片概念。现有左侧导航及顶部工具栏保留，只增加系统优化入口和右侧内容。

```text
Use case: ui-mockup.
Correct a WebNav system optimization plugin design to FIT THE EXISTING APPLICATION rather than replacing it.
INPUT IMAGE 1 is the actual implemented WebNav app screenshot and is the authoritative application shell. INPUT IMAGE 2 is an earlier optimization concept and is ONLY a reference for the colored-card treatment in the right content area.
Generate a high fidelity 1440x960 landscape UI mockup.

CRITICAL: preserve the actual application's existing light sage LEFT SIDEBAR from Image 1: original WebNav brand, section “工作空间”, “所有服务器” (2), “收藏夹”, “最近使用”, divider, “服务器分组” plus button, “未分组” (2), and bottom tools. Add exactly ONE new button “系统优化” with sliders icon in the existing bottom “工具” section immediately below “任务管理器”. Select this new button. Retain “插件中心” and “管理中心” below. Do not replace left navigation with plugin categories. Do not recolor the host sidebar dark. Do not add ANY “返回工作台” button.
Preserve the existing top host toolbar across right side: navigation icons on left, existing “任务管理器” tab inactive, add active tab “系统优化” with a close x, global “搜索服务器” input with Ctrl K, gear, appearance icon. Host controls should look like original, not a new branded app.

ONLY the right workspace content below top toolbar changes:
Title row at x~260 y~98: sliders icon and “系统优化”, small “本机” badge, small “Windows 11 · 设计示例”, right small jade action “重新扫描”.
Below that, one HORIZONTAL internal tab navigation row: “概览” selected with green underline, “开机启动”, “系统设置”, “空间清理”, “应用管理”, “恢复记录”. These categories exist only inside the right pane.
A slim quiet line “扫描完成 · 刚刚更新” before the cards.

Right content design: refined modern cards, strong separate FULL-WIDTH COLORED HEADER STRIPS contrasted with WHITE CONTENT BODIES, 12px radii, 18px gutters, crisp Chinese typography, little text. Use restrained forest #17624F, slate blue #345C7B, ochre #835F16; actual host canvas stays pale sage gray. No full colored body cards.

Row 1, 60% width startup card and 40% width cleanup card, height 260:
Startup card header forest with white icon “开机启动” and “管理 →”. White body large “12” caption “已启用”, small chips “第三方 8” and “系统 4”. Three compact rows “云同步”, “游戏启动器”, “会议助手”, small simple icons, trailing current-state badges “已启用” / “已停用” (not immediate toggles on overview). Footer “查看全部 →”.
Cleanup card slate-blue header “空间清理”, white body large “2.4 GB” “可清理空间”, horizontal segmented bar, rows “临时文件 2.1 GB”, “回收站 0.3 GB”, button “查看明细”.
Row2 three equal cards, height230:
“系统设置” blue header with white text, white body icon rows “文件扩展名” status “已显示”, “系统推荐” status “已开启”, “窗口动画” status “已开启”, small “更多设置 →”.
“应用管理” ochre header white text, body “48” caption “已安装”, compact chips “桌面应用” and “商店应用”, button “查看应用 →”.
“恢复记录” teal header white text, body two minimalist timeline rows “启动项调整” / “今天 14:20”, “资源管理器设置” / “昨天”, undo icon buttons.
Bottom action tray within right pane only: left “已选 3 项”, tag “可恢复”, right jade button “预览更改”.
Keep white breathing room and balanced density. This is an embedded plugin page inside existing WebNav. No replacement of host shell, no secondary vertical sidebar, no return-to-workspace button, no advertising or health scores. All numbers are illustrative and the tiny “设计示例” badge must be visible.
```

## 开机启动图

输出：[system-optimizer-startup.png](system-optimizer-startup.png)。参考一为上述最终总览图，参考二为早期启动项内容布局；仅保留后者的内容信息层次。

```text
Use case: ui-mockup.
Edit reference 1, the corrected WebNav system optimization overview, into its “开机启动” internal tab. Reference 2 is the old startup detail mockup only for right-pane data layout; NEVER reuse reference 2's sidebar.
Preserve reference 1's ENTIRE existing host shell: LIGHT sage left sidebar with WebNav, 工作空间, 所有服务器 2, 收藏夹, 最近使用, 服务器分组, 未分组 2; bottom 工具, 任务管理器, selected 系统优化, 插件中心, 管理中心. Preserve host top tabs 任务管理器 and selected 系统优化, 搜索服务器 with Ctrl K, settings and appearance icons. No replacement navigation, no “返回工作台”, no second sidebar. Landscape 1440x960 polished screenshot.
Right workspace heading remains “系统优化”, badge “本机”, small “Windows 11 · 设计示例”, right refresh “重新扫描”.
Same horizontal internal tabs: 概览, 开机启动 (selected with green underline), 系统设置, 空间清理, 应用管理, 恢复记录.
Under tabs compact toolbar: title “开机启动”, status chips “已启用 12” “已停用 5” “待处理 1”, and right search “搜索启动项”. A compact source row below uses tabs “登录项” selected, “计划任务”, “服务”; right checkbox “隐藏系统项”.
Main content cards: 65% left, 35% right, 18px gap. Every card has full-width distinct colored title strip and WHITE body. Modern spacious but concise.
Left card header slate blue with white “登录启动”, small “17 项”. Underneath five compact aligned list rows:
OneDrive / Microsoft / 注册表 / 已启用 / green toggle
Steam / Valve / 注册表 / 将停用 / gray toggle; selected pale sage row and checked selection box.
Microsoft Teams / Microsoft / 应用 / 已启用 / disabled-looking read-only badge “系统管理” instead of toggle.
WebNav / 当前工作台 / 启动文件夹 / 已启用 / link “托盘设置” instead of toggle. WebNav's own autostart is read-only in this plugin.
示例更新助手 / 发布者未知 / 注册表 / 已停用 / gray toggle.
Name, publisher subline, source badge, state and action. Restrained small real app icons. Under list “显示 5 / 17” compact pagination. Footer “更改将在确认后生效”.
Right card forest header white “启动项详情”. White body Steam icon “Steam”, “Valve”; concise metadata “来源 注册表 · Run”, “范围 当前用户”, “签名 已验证”, “启动影响 未测量”. Light gray path box “程序位置” and “C:\Apps\Steam\steam.exe” with copy/folder icons. Amber very short pending block “待执行 · 停用开机启动” and “下次登录生效”. Link “撤销选择”.
Below right card smaller card slate teal header “最近调整”, white body “会议助手 · 已停用”, “今天 14:20”, undo button.
Bottom right-pane action tray only: “已选 1 项” and “可恢复”, right buttons “取消选择” and jade “预览更改”.
Keep host UI recognizable and unchanged; only its right pane changes. Clear full-color title band / light body separation, sharp Chinese type, small words, aligned controls, no huge marketing hero, no health score, no claimed performance improvement. All data illustrative.
```

两图为布局概念，数字和路径均为示例；不是运行界面或实测结果。最终范围与交互约束见 [系统优化方案](../system-optimizer.md)。

