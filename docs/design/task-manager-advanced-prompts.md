# 任务管理器增强版效果图生成记录

2026-10-28。使用内置 imagegen 编辑生成，四张图片均为概念图和示例数据；最终范围见[跨平台任务管理器提案](../task-manager.md)。保留[初版提示词](task-manager-prompts.md)供追溯。

## Windows 高级进程视图

[效果图](task-manager-advanced.png)。以第一版进程管理图作为编辑目标。

```text
Use case: ui-mockup.
Edit the supplied WebNav task-manager screenshot into a substantially more capable advanced process-inspection view inspired by the useful information architecture of System Informer / Process Explorer, while preserving WebNav brand and calm light grey-sage style. Input image is the existing WebNav concept, not a competitor screenshot. This is an evolved design proposal, NOT the shipping UI.
Output one polished front-on flat desktop application screenshot, wide 16:9, preferably 2048x1152 or similarly high resolution. Crisp highly legible Simplified Chinese UI. No perspective, browser chrome, oversized dashboard cards, decorative gradients or cyberpunk. Preserve left navigation, WebNav logo, top workspace tabs and toolbar. Use background #f3f5f2, surfaces near white, forest accent #426653, ink #25342c; restrained amber for hot CPU, blue-grey for child processes. Dense but carefully aligned readable tables.

Main workspace:
Header title 任务管理器, small secondary 本机 · DEV-WORKSTATION · Windows 11. Right a two-choice 简洁 / 高级 control with 高级 selected, shield 普通权限, pop-out icon. A tiny clearly visible 设计预览 · 示例数据 label.
Horizontal primary tabs: 进程 selected, 性能, 网络, 磁盘, 服务, 启动项, 事件. At far right a prominent subtle outline magnifying-glass action 查找资源 with Ctrl F.
A very compact single resource summary strip about 65px tall: CPU 62%, 内存 66%, 磁盘 8%, 网络 3.2 Mbps, GPU 24%, with understated tiny sparklines, no separate cards.
Process toolbar with search placeholder 搜索进程、PID 或路径, filter 全部进程, toggle 树状, column icon labelled 列, pause icon and 更新 1 秒.

Below make TWO stacked table panes on left (about 75% of content width) and a slim full-height process overview on the right (about 25%).
UPPER left pane is a real visibly expanded parent-child process tree, about 8 visible rows with subtle tree connector lines, disclosure arrows and small app icons.
Columns 名称, PID, CPU, 内存, I/O, 用户, 签名.
Rows:
explorer.exe | 4632 | 1.2% | 186 MiB | 0 MB/s | demo | 已验证
  Code.exe | 7420 | 3.1% | 398 MiB | 0.1 MB/s | demo | 已验证
    node.exe | 12648 | 34.6% | 826 MiB | 8.2 MB/s | demo | 已验证
    node.exe | 13124 | 1.4% | 164 MiB | 0.3 MB/s | demo | 已验证
  chrome.exe (12) | — | 9.2% | 3,184 MiB | 0.4 MB/s | demo | 已验证
services.exe | 980 | 0.1% | 12 MiB | 0 MB/s | SYSTEM | 已验证
  svchost.exe | 3088 | 0.3% | 78 MiB | 0 MB/s | SYSTEM | 已验证
WebNav (3) | — | 0.6% | 158 MiB | 0 MB/s | demo | 本工作台
Select the node.exe 12648 row with pale sage background and green left accent. Only its CPU cell has warm amber tint. Do not make the whole list rainbow colored. Avoid unexplained alarm icons. Table footer or slim split bar says 已选 node.exe · PID 12648 and shows a centered resize grip.

LOWER left pane is the process diagnostics pane, about 240px high with full horizontal tabs:
概览 线程 26 模块 68 句柄 418 内存 网络 3 服务
句柄 418 is selected with green underline. Below a short filter 查找句柄名称 and filter 所有类型, and right an action 全局查找.
Table columns 类型, 名称 / 路径, 句柄, 访问.
Four rows:
文件 | C:\Work\demo\cache\build.db | 0x034C | 读 / 写
文件 | C:\Work\demo\cache\build.db-wal | 0x0350 | 读 / 写
命名管道 | \\Device\\NamedPipe\\demo-worker | 0x02F8 | 读 / 写
事件 | Local\\demo-build-ready | 0x0194 | 同步
A small footer 已加载 4 / 418 个 · 按需读取. Each path uses compact monospace. This is a readonly inspection panel; do not show Close Handle action.

RIGHT overview:
header 进程概览 and close icon.
Small green node app icon, bold node.exe, PID 12648.
Show 签名已验证 and OpenJS Foundation as modest separate text, not a security verdict.
Key-value lines 父进程 Code.exe · 7420 with a link arrow; 用户 demo; 权限 普通; 启动 14:06:12; 优先级 正常.
A clear executable path label 文件位置 and C:\Tools\node\node.exe, copy icon.
Small sparkline CPU 34.6% · 最近 60 秒, then key-values 线程 26 / 句柄 418.
Compact useful linked row 监听端口 5173 →.
Two neutral small buttons 暂停 and 优先级, then one muted red outline button 结束进程 and text secondary 结束进程树. Do not present a giant red danger zone.
Very bottom global footer 186 个进程 · 最近更新 14:32:00 and 设计预览 · 示例数据.

Ensure main tree and lower diagnostics pane are unmistakable: developer can select a child process and immediately inspect its file handles while retaining overview. Correct Chinese and clear spacing take priority over extra ornament. Do not include any malware labels, antivirus verdicts, unsigned-is-malicious implication, or fake claims of actual measured data.
```

## 资源查找

[效果图](task-manager-resource-finder.png)。以 Windows 高级视图作为编辑目标。

```text
Use case: ui-mockup.
Edit the supplied WebNav advanced task-manager screenshot into a SECOND screen demonstrating its most valuable new diagnostic feature: 查找资源. Preserve the light grey-sage WebNav brand, fixed left sidebar, top workspace tabs, Chinese typography, forest-green accent, dense but elegant technical UI. Front-on flat desktop screenshot, wide 16:9, high resolution. Input is the prior advanced WebNav mockup and is the screen edit target. All data is illustrative. No photographs, dark theme, neon, excessive warning design, or marketing graphics.

Keep left navigation and upper toolbar unchanged. Title 任务管理器 with subtitle 本机 · DEV-WORKSTATION · Windows 11, 普通权限 and 高级 selected at right. Keep primary tabs 进程, 性能, 网络, 磁盘, 服务, 启动项, 事件 and top-right 查找资源. Show 设计预览 · 示例数据 small.

In the content area replace process inspection with a prominent full-size in-workspace resource search panel, NOT a browser window, NOT a tiny popup. A thin breadcrumb 返回进程 above panel.
Panel top: magnifying glass / file icon, bold 查找资源, subtitle 从文件、DLL 或端口，找到所属进程. A close x at far right.
Search row: wide input containing build.db, green 查找 button, small 清除 action. Under input three type options 文件 / 句柄 selected, DLL / 模块, 端口 / 连接. A secondary selector 名称包含, and 范围：当前可访问进程.
Next a compact result status 3 条结果 · 2 个进程 with an amber small label 部分进程不可访问. This is a coverage label, not a malware alarm. A tiny 已完成 status on right.

Content two columns: left 68 percent results table, right 32 percent detail pane.
Results table columns 所属进程, PID, 类型, 资源路径, 句柄.
Rows:
node.exe | 12648 | 文件 | C:\Work\demo\cache\build.db | 0x034C
node.exe | 12648 | 文件 | C:\Work\demo\cache\build.db-wal | 0x0350
DB Browser for SQLite | 18340 | 文件 | C:\Work\demo\cache\build.db | 0x0218
Use small app icons, dark readable text, thin row separators, enough room for resource paths, selected first row pale green with green left bar. Highlight only substring build.db in each path with very light yellow. Process labels may wrap two lines, full paths stay readable. Numeric PID and handles align. Below table a slim muted line 查询范围受当前权限限制 and an unobtrusive 查看覆盖范围 link.
Under table, an orderly lower evidence strip with two compact process summaries:
node.exe · PID 12648 / 父进程 Code.exe · 7420 / CPU 34.6% / 打开 2 个匹配资源
DB Browser for SQLite · PID 18340 / CPU 0.2% / 打开 1 个匹配资源
Use natural plain rows, no huge dashboard tiles.

Right pane heading 资源详情.
Large file icon and bold build.db. Secondary 文件.
资源路径 then C:\Work\demo\cache\build.db with copy icon.
所属进程 node.exe · 12648 as link.
句柄 0x034C.
访问 读 / 写.
发现方式 文件句柄.
A quiet informative note 查询到文件句柄，尚不能判断是否阻止删除. Do not label as proven exclusive lock or safe-to-close.
At bottom green primary button 定位到进程 and a light outline button 查看句柄. A small copy icon action 复制路径. NO close-handle or forced-unlock action.
Below the two columns a subtle helper row heading 也可以这样查 with two natural example tokens libssl.dll and 5173, and short text DLL 加载者 / 端口所属进程. No tutorial paragraphs.
At bottom footer 更新于 14:32:00 and 设计预览 · 示例数据.

Keep this a refined, usable investigative tool. Main story: find which processes have a file open, understand evidence and coverage, navigate back to the precise process. All labels clear Simplified Chinese. Preserve shell invariants and color style from reference.
```

## 目标选择与 Linux SSH 监控

[效果图](task-manager-remote.png)。以 Windows 高级视图作为编辑目标，扩展三平台和目标选择。

```text
Use case: ui-mockup.
Edit the supplied advanced WebNav task-manager screenshot into the final CROSS-PLATFORM REMOTE MONITOR design. Preserve its high-quality light sage WebNav shell, left navigation, top workspace tabs, compact typography, thin borders, advanced split-pane layout. Flat front-on wide 16:9 desktop app UI, high resolution, crisp Simplified Chinese text. No browser chrome, perspective, neon or unrelated new branding.

The defining feature is a clearly visible TARGET SELECTOR near the main title 任务管理器. Current target is 构建机 · Linux with small SSH badge. Subtitle SSH · demo@build-linux · x64. On right 高级 selected, green 已连接, shield 普通权限, small 设计预览 · 示例数据. The selector dropdown is OPEN, floating directly under the target selector at top left of main content, approx 350px wide and tall enough for four entries. It must not hide all the table.
Dropdown title 选择监控目标, a small search 搜索服务器或 SSH 入口, and four distinct choices:
本机 / Windows · 当前电脑;
构建机 / SSH · Linux · x64 / green check selected;
开发 Mac / SSH · macOS · Apple Silicon / amber 未安装采集器;
测试 Windows / SSH · Windows · x64.
These are fictional examples, do not add real IPs or secrets. Small text bottom 选择已保存的 SSH 入口.

Keep primary tabs 进程, 性能, 网络, 磁盘, 服务, 启动项, 事件. Far right 查找资源 Ctrl F.
Compact metrics CPU 62%, 内存 21.2 / 32 GiB, 负载 4.2 / 3.8 / 3.5, 网络 3.2 Mbps; avoid a fake GPU metric on the Linux sample.
Toolbar search 搜索进程、PID 或路径; 树状 selected; 列; pause; 更新 1 秒.

Main upper left pane process tree uses Linux processes, NOT Windows .exe names. Columns 名称, PID, CPU, 内存, I/O, 用户, 状态.
Show about 8 rows with clear parent-child indentation and connector lines:
systemd | 1 | 0.1% | 14 MiB | 0 MB/s | root | 运行
  sshd | 1024 | 0.1% | 12 MiB | 0 MB/s | root | 休眠
    bash | 2180 | 0.2% | 8 MiB | 0 MB/s | demo | 休眠
      node | 12648 | 34.6% | 826 MiB | 8.2 MB/s | demo | 运行
      node | 13124 | 1.4% | 164 MiB | 0.3 MB/s | demo | 休眠
  postgres | 4096 | 4.3% | 948 MiB | 1.2 MB/s | postgres | 运行
  nginx | 2056 | 0.8% | 36 MiB | 0.2 MB/s | www-data | 休眠
webnav-collector | 18124 | 0.2% | 18 MiB | 0 MB/s | demo | 采集中
node 12648 selected pale green, its CPU cell muted amber.
Split bar 已选 node · PID 12648.

Lower left pane diagnostic tabs 概览, 线程 26, 模块 68, 文件 42 selected, 内存, 网络 3, 服务. File panel uses file descriptors, not Windows handles.
Columns 类型, 路径, FD, 访问.
文件 | /home/demo/build/cache/build.db | 17 | 读 / 写
文件 | /home/demo/build/cache/build.db-wal | 18 | 读 / 写
套接字 | 127.0.0.1:5173 | 21 | 监听
管道 | pipe:[18452] | 8 | 读
Small footer 已加载 4 / 42 项 · 按需读取.

Right pane 进程概览: node icon, node, PID 12648, parent bash · 2180, 用户 demo, 权限 普通, 启动 14:06:12, nice 0, executable /usr/bin/node. Green CPU sparkline 34.6%, threads26 and files42. 监听端口 5173 →. Neutral 暂停 and 优先级 buttons. Muted red 结束进程 button and 结束进程树 secondary.
Bottom status bar SSH 已连接 · 采集器就绪 · 每秒更新, and 设计预览 · 示例数据.

Most important visual story: the SAME task manager can switch between the local Windows computer and any saved SSH target, including Linux, macOS and Windows. Clearly legible OS-specific Linux process and file data, visible target dropdown and uninstalled Mac state. Keep background UI coherent even where dropdown overlaps. Do not display hypothetical unsupported data as live validated measurements.
```

## macOS SSH 首次安装

[效果图](task-manager-install.png)。以上一张跨平台视图作为编辑目标，展示采集器未安装状态。

```text
Use case: ui-mockup.
Edit the supplied cross-platform WebNav task-manager screenshot into its first-use installation screen for a macOS SSH target. Preserve WebNav sidebar and top toolbar, light grey-sage background, forest-green accent, readable Chinese desktop UI and wide 16:9 aspect. Flat production application, no browser chrome, no marketing illustration.

Header title 任务管理器. Target selector now closed and reads 开发 Mac · macOS with SSH badge. Subtitle SSH · demo@dev-mac · Apple Silicon. Header right 简洁 / 高级, with 高级 selected. Status 已连接 SSH but separately show 采集器未安装. Keep small 设计预览 · 示例数据. Primary navigation 进程, 性能, 网络, 磁盘, 服务, 启动项, 事件 is visible but greyed because no monitoring data yet. There must be NO old Windows or Linux process rows or stale metrics.

Main content a generous calm empty-state with a centered installation panel about 780px wide and 550px tall, aligned slightly above vertical center. No intimidating danger-modal and no consent checkbox.
A small minimal download-to-computer line icon at top left of panel, bold 尚未安装采集器.
Supporting text: 安装轻量采集器后，即可查看这台 Mac 的进程与性能。
Below a two-column aligned target summary with thin separators:
目标设备 开发 Mac
连接方式 SSH · demo@dev-mac
目标系统 macOS · arm64
运行权限 当前 SSH 用户
安装位置 a readable path shown on two lines: ~/Library/Application Support/WebNav/task-manager/
Include a small neutral note 已识别目标系统，将自动选择兼容程序.

Then a four-step horizontal numbered process with light grey links:
1 准备程序 → 2 上传校验 → 3 启动采集 → 4 显示数据
These are upcoming steps, no pretend completed installation or progress percentage.

A quiet feature row with small outline icons and three short labels:
远端无需联网
无需安装运行环境
通过 SSH 传输
Below it a short muted sentence 按需运行，断开后停止；保留程序供下次使用。
At bottom panel a large forest-green filled primary button 安装并连接 and light secondary button 切换目标. No duplicate install CTA. This is the single explicit action that starts the automated installation.
Very bottom of panel a collapsible 技术详情 chevron, closed. Keep raw hash, release filenames, protocol details and admin command lines out of the default user flow.

Below panel a small line 已安装过？重新检测 with 重新检测 as text action. Lower app footer SSH 已连接 · 等待安装 and 设计预览 · 示例数据.

Make the intent unmistakable: choose ANY saved SSH target, if it lacks the lightweight collector click ONE 安装并连接 button, then automatic upload, verification and launch. This is an ordinary internal-machine management workflow, not a separate onboarding wizard. Do not claim installation has happened. Preserve polished spacing, Chinese accuracy and consistency with the reference app.
```
