# 任务管理器效果图生成提示词

2026-10-28。使用内置 imagegen 生成两张概念图，均为示例数据，不代表插件已实现或已测得性能。设计范围见[本机任务管理器提案](../task-manager.md)。

## 进程管理

输出：[进程管理效果图](task-manager-processes.png)。全新生成，无输入图片。

```text
Use case: ui-mockup.
Create ONE high-fidelity Chinese desktop web application screenshot, exactly a wide 16:9 composition, target 1920x1080. This is a proposed WebNav task-manager plugin for a local Windows workstation. Flat front-on production-quality interface, crisp accurate Simplified Chinese typography. No perspective, no laptop, no browser chrome, no presentation captions outside the UI.

Visual design: follow WebNav's existing practical design language: very light grey-sage page #f3f5f2, nearly white surfaces #fcfdfb, ink #25342c, muted grey-green #637067, restrained forest-green accent #426653, thin grey-green dividers, 7px control radii, 12px pane radii. Segoe UI / Microsoft YaHei style typography. Compact productive desktop density, elegant alignment, excellent legibility. Avoid excessive whitespace, marketing design, glass, gradients, big KPI cards, purple, dark dashboard, donut charts.

Layout:
A fixed 218px left application sidebar. At top a simple dark-green W symbol and WebNav. Under 工作空间: 所有服务器, 收藏夹, 最近使用. Below 本机工具, selected 任务管理器 with a small pulse-window outline icon. At bottom 插件中心 and 管理中心, and a short muted 本机服务已连接.
A 58px app-wide top toolbar above the main area with sidebar toggle, tabs 目录 and selected 任务管理器 with an x, a compact 搜索服务器 field, gear and appearance icons right.
Main workspace header at x250: title 任务管理器, subtitle 本机 · DEV-WORKSTATION · Windows 11. On right show normal shield icon and 普通权限, pop-out icon and more icon.
Second line is a clear horizontal navigation: 进程 selected with forest green underline, 性能, 启动项, 服务. Nearby a tiny unobtrusive 设计预览 · 示例数据 label, to distinguish mock data from real monitoring.
A single horizontal resource summary strip, not isolated cards: CPU 62% with thin small green sparkline; 内存 66% / 21.2 / 32 GB in a subordinate line; 磁盘 8%; 网络 3.2 Mbps; GPU 24%. Very subtle separators. All indicators modest.
Below: search field 搜索名称、PID 或发布者, a segmented 全部 / 应用 / 后台 / Windows filter, compact 树状视图 checkbox enabled, then 暂停 icon and 更新：1 秒 dropdown. Maintain adequate width and no cramped text.

Content fills most of screen. 72% width process table, 28% right inspector separated by a thin divider. Table header 名称, PID, 状态, CPU with descending arrow, 内存, I/O. Numeric columns right aligned with tabular numbers. CPU cells use low saturation amber heatmap only for high usage. Rows approximately 45px high, tree disclosure arrows, tasteful small app icons, not emoji. About 11 visible rows. Names and values:
RenderWorker.exe | 14820 | 未响应 | 38.4% | 1,452 MB | 8.2 MB/s
Google Chrome (12) group | — | 运行中 | 9.2% | 3,184 MB | 0.4 MB/s
Visual Studio Code (8) group | — | 运行中 | 4.6% | 1,036 MB | 0.1 MB/s
Windows 资源管理器 | 4632 | 运行中 | 3.1% | 186 MB | 0 MB/s
Desktop Window Manager | 2140 | 运行中 | 1.4% | 246 MB | 0 MB/s
Antimalware Service | 3088 | 运行中 | 1.3% | 322 MB | 0.3 MB/s
PowerShell | 12648 | 运行中 | 0.8% | 94 MB | 0 MB/s
WebNav (3) group | — | 本工作台 | 0.6% | 158 MB | 0 MB/s
任务管理器采集器 | 18124 | 运行中 | 0.3% | 28 MB | 0 MB/s
其他 Windows 进程 (146) group | — | 运行中 | 2.6% | 2,136 MB | 0.1 MB/s
First row is selected in pale sage and has a narrow green left selection mark; 未响应 in muted amber. Footer beneath list: 186 个进程 · 已选择 1 项; last updated small.

Right inspector: header 进程详情 with close icon. Small restrained application icon and RenderWorker.exe bold. Subtitle PID 14820. Status amber dot 未响应. A 60-second compact CPU line graph with green line and very subtle fill, heading CPU 38.4%. Two aligned compact key-value lines 内存 1,452 MB / 线程 24, 启动时间 14:06 / 用户 demo. A readable 文件位置 label then C:\Tools\Render\RenderWorker.exe on two lines maximum, copy-location icon. Clearly identified as a fictitious sample app by the global preview badge.
Bottom inspector contains one full-width muted red outline button 结束任务 and a secondary text action 结束进程树. Supporting short text 结束前将确认目标进程. No huge warning dialog in this screen.

At the very bottom status line show 每秒更新 · 最近 60 秒, and 设计预览 · 示例数据.
Make a complete coherent realistic application layout, all panels aligned, readable Chinese text, tables must be the primary visual. Use restrained semantic green for selection, amber only for high CPU/unresponsive, red only for termination. This image is a design mockup, not a real measured system screenshot.
```

## 性能监控

输出：[性能监控效果图](task-manager-performance.png)。以上一张进程管理图为本地参考及编辑目标，保留应用外框与视觉风格，切换为性能页。

```text
Use case: ui-mockup.
Edit the supplied WebNav task-manager design screenshot into a SECOND complete screen of the SAME application: the 性能 tab. Reference image is both style reference and screen edit target. Preserve the entire left WebNav navigation, brand, top workspace tabs, search and settings, light grey-sage palette, dark green typography, thin borders, controls, sizes, spacing and desktop aspect ratio. Render crisp legible Simplified Chinese text. No browser chrome, no photography, no 3D, no gradients, no neon.
Keep main title 任务管理器 and subtitle 本机 · DEV-WORKSTATION · Windows 11. Header right 普通权限 plus pop-out and more icons. Four tabs 进程, 性能, 启动项, 服务. Move active underline to 性能. Keep 设计预览 · 示例数据 visibly in top right.

Replace the process table and inspector with a precise performance workspace:
On left within main content, a 220px-wide resource selector list, separated by divider. Six compact vertically stacked rows, each with one tiny sparkline on left and two-line label/value on right:
CPU selected pale sage, 62% · 3.72 GHz;
内存, 21.2 / 32 GB (66%);
磁盘 0 (C:), SSD · 8%;
以太网, 接收 3.2 Mbps;
GPU 0, 24% · 2.4 / 8 GB.
Use a restrained green for CPU, muted blue for memory, soft ochre for disk and blue-grey for network. Indicate only selected row with pale tint. Beneath devices a small note 本机采集 · 每秒更新.
On right, the main performance canvas:
Title CPU large but practical, secondary 16 核 · 24 逻辑处理器. On upper right a pause icon and 1 秒 dropdown, and time selector 60 秒 selected / 5 分钟. Below a single large 60-second CPU usage plot filling about 60% of available width and 280px height. Light grey grid lines, green non-repeating realistic usage series varying between 25 and 80 percent, ending 62%; very subtle green area fill, label 使用率 and Y-axis 100% to 0%, X-axis 60 秒 and 0. Above plot a bold 62% and small green CPU legend, no giant gauge.
To right of main graph, a narrow list 占用最高的进程 with RenderWorker.exe 38.4%, Google Chrome 9.2%, Visual Studio Code 4.6%, calm thin horizontal indicators. Bottom link 查看进程 →.
Under main graph a compact inline row of actual performance labels and values: 利用率 62% · 速度 3.72 GHz · 进程 186 · 线程 3,280 · 运行时间 1 天 04:26:18.
Lower region two equal-width secondary performance charts, larger than tiny cards and taking up available width: left 内存 66% with a smooth muted-blue graph, label 21.2 / 32 GB; right 网络 with two labelled lines 接收 3.2 Mbps, 发送 0.4 Mbps and a blue-grey spiky throughput plot. Each graph has 60-second time bounds and appropriate units. Clean visual hierarchy, no redundant extra summary strip.
Footer: 更新于 14:32:00, and 数据仅用于设计示例. No historic dates or invented validation labels.
Retain all style and UI shell invariants of the supplied image. Make a balanced practical attractive task-manager performance view, information-rich without overcrowding. Exact Chinese text matters. The charts are explicitly illustrative mock data.
```

