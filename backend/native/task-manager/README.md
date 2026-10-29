# WebNav 原生任务采集器

版本 `0.3.1`，协议 `1`。即时查看由 WebNav 按需以独立子进程或 SSH exec 启动，无启动参数；显式开启持续记录时，使用固定内部 `--record` 模式启动目标独立后台进程。安装位置由宿主管理，三平台统一为当前用户的 `~/.webnav/tools/task-manager/<version>/<platform-arch>/`；记录位于同级 `recording-v1`。本程序不安装系统服务、不创建端口、不修改自启。命令行仅由单进程按需请求返回，不加入快照或历史；不读取环境变量和内存正文。

## 构建与验证

在仓库根目录执行：

```sh
node scripts/task-manager-build.mjs --test
node scripts/task-manager-build.mjs
node scripts/task-manager-build.mjs --verify
```

需要 Go 1.26 或更新版本。可通过 `WEBNAV_GO` 指定可执行文件；构建脚本也识别本目录 `.native-deps/go/bin/go[.exe]` 下的便携工具链，否则使用 PATH 中的 Go。构建使用 `CGO_ENABLED=0`、锁定的 `go.mod` / `go.sum`、独立模块及编译缓存，目标机器无需安装 Go、Node 或 Python。构建命令不自动下载安装工具链。

`--test` 仅执行本机原生测试。默认构建 Windows / Linux / macOS 的 x64 和 arm64 六个程序，输出到忽略 Git 的 `package/`。清单为 `package/manifest.json`，包含版本、协议、相对路径、字节数与 SHA-256。`--verify` 只核对现有六个产物，不重新生成程序或清单。`package/licenses/` 和 `THIRD-PARTY-NOTICES.txt` 包含 Go 运行时以及固定版本依赖的原始许可证，正式发行应连同程序保留。

2026-10-28 实际使用经官方摘要核验的 Go `1.27.3 windows/amd64`，依赖 `gopsutil/v4 v4.26.9`，六目标交叉构建及摘要核对通过。编译器的最低系统要求见 [Go 官方要求](https://go.dev/wiki/MinimumRequirements)：当前产物要求 Windows 10 / Windows Server 2016 及以上、macOS 13 及以上；Linux 运行时最低内核 3.2，但结束进程需要内核 5.3 引入的 pidfd 支持。交叉编译不等于在这些最低版本完成运行验收。

macOS x64 产物已在用户指定的 MacBook Pro 通过 SSH 安装、连续采样与重连验证；发行签名、公证和 arm64 实机仍未验收，不得关闭 Gatekeeper / SIP 作为安装步骤。Linux 无 CGo，不依赖目标安装 glibc 或 musl 的独立运行库。范围见[SSH 实机验证](../../../docs/task-manager.md#windows-ssh-连接修复与-macos-实机验证)。

## 协议与边界

stdin/stdout 使用 UTF-8 JSON lines。请求为 `{v:1,id,method,params}`，ID 是长度 1–128 的字符串。方法只有 `hello`、`snapshot`、`details`、`commandLine`、`terminate`、`ping`、`stop`，以及 0.3 新增的 `recording.status`、`recording.configure`、`history.query`、`history.point`。每行请求不超过 256 KiB；每行响应不超过 2 MiB，包含换行。未知字段、未知方法、错误参数直接拒绝，不提供任意命令接口。stdout 只写协议，错误使用固定公开代码和描述。

快照最多 10,000 个进程，并按实际编码字节再次裁剪。无法读取创建时间或内存的进程省略，同时标记 `truncated`；首次 CPU 采样或不可读时返回 `null`，CPU 按整机逻辑核数归一到 0–100%。详情每类别最多 200 条，缺失权限、平台能力和截断均通过 `unavailable` 声明。Windows 的用户名、执行文件按 PID 与创建时间缓存，进程基本资料通过单次 Toolhelp 快照读取。

即时查看空闲 30 秒自动退出，宿主应定期采样或 ping。单次采集预算 15 秒，超时后退出前台进程；EOF、stop 和宿主回收都会结束前台采集。持续记录器采用独立锁、配置与后台生命周期，不因查看断开而停止；两种模式均无 TCP 监听，也不会因断开而结束被观察进程。

| 平台 | 公共能力之外的进程操作 | 详情 |
| --- | --- | --- |
| Windows | `terminate-force`，必须明确选择强制结束 | Toolhelp 模块路径、线程 ID、TCP/UDP；文件/句柄声明不可用 |
| Linux | `terminate-graceful` / `terminate-force`；没有 pidfd 时明确拒绝 | 有界文件描述符、映射路径、线程 ID / 状态、TCP/UDP |
| macOS | 当前版本只读 | TCP/UDP 受系统权限和系统工具可用性限制；文件、模块、线程声明不可用 |

公共能力是 `processes,cpu,memory,details,command-line,performance,recording,history`。以上线程信息不包含线程 CPU 占比或调用栈；网络端点不等于进程吞吐。Windows 的常规结束请求返回不支持，绝不自动转成强制结束。macOS 暂不发送 PID 信号，需实现并验证稳定 Mach task 句柄后再启用操作。

0.3.1 的 `commandLine {pid,startedAt}` 在读取前后复核身份，返回 `{pid,startedAt,commandLine,truncated,unavailable?}`。文本最多 32 KiB UTF-8，空字符串表示实际为空；无法读取时为 `null`，原因是 `permission` 或 `unavailable`。Windows 使用 `NtQueryInformationProcess / ProcessCommandLineInformation` 与有界查询缓冲；Linux 有界读取 `/proc/<PID>/cmdline` 并保留参数边界；macOS 使用固定 `/bin/ps -ww -p <PID> -o command=`，3 秒预算、有界输出、登记并回收子进程。不自动提权，不缓存或记录命令行，显示值不能直接用作重启动作。2026-10-28 Windows x64 原生测试与宿主 WS 测试通过；Linux/macOS 新读取路径仅交叉编译，未实机验收。

## 0.2 性能采样

快照的新增 `performance` 字段仍使用协议 1，包含实际采样时间、最多 4,096 个逻辑核心、64 个磁盘设备和 16 个 GPU / 显示适配器。不可用原因去重后最多 64 项。设备计数器按身份保存有限的上次采样；首样本、计数器回退、设备重现、CPU 拓扑改变和无有效时间间隔时返回 `null`，不会用整机 CPU 平均值填充每个核心。旧版采集器需要更新到 0.2 才提供该字段。

逻辑核心使用 `gopsutil cpu.Times(true)` 返回的实际编号。Windows 固定依赖版本通过全部处理器组查询，旧系统回退导致不足时标记部分覆盖。总 CPU 和每核计算排除 Linux 重复包含的 guest 时间及 Windows 重复包含的中断时间。

Windows 磁盘直接枚举 `PhysicalDrive`，读取 [DISK_PERFORMANCE](https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ns-winioctl-disk_performance) 字节计数和空闲时间、物理容量；Linux 读取 `/sys/block` 的[内核统计](https://docs.kernel.org/admin-guide/iostats.html)，按 512 字节扇区换算；macOS 使用 IOKit 实际读写字节，但不把重叠的读写服务时间冒充活动时间。吞吐按单调时钟时间差计算，Windows 活动时间还排除系统时钟跳变。容量只表示对应设备总量，不把分区或文件系统的已用空间贴到物理磁盘上；`usedBytes` / `mount` 当前不推断。

Windows 的 Intel/NVIDIA/AMD GPU 使用 PDH + DXGI，按 LUID 关联引擎利用率及专用/共享内存；GPU 专用内存含本地显存和 DXGI DedicatedSystemMemory 预留。相同型号可能有多个显示适配器，不能当成多张物理显卡。固定 System32 或 Program Files/NVIDIA Corporation/NVSMI 中的 `nvidia-smi.exe` 补充 TCC/MCDM 计算设备，不重复添加 WDDM 设备。

Linux 的 Intel i915/xe 使用 DRM fdinfo 真实引擎增量，按 PCI/客户端去重并验证进程创建身份；范围明确是可访问进程。只读 DRM memory query 取设备本地容量；Xe 返回普通用户可访问的实际内存，i915 根据权限和 ABI 区分真实已用量与内核隐藏值。不累计客户端共享页来冒充整卡内存。AMD 使用 sysfs 的 GPU 利用率、VRAM 和独立 GTT 共享内存；NVIDIA 使用驱动的固定路径 nvidia-smi，并按 PCI 关联，缺少工具仍保留设备及原因。保持静态 Linux 程序，不为了动态 NVML 引入 libdl/glibc 依赖。

macOS 使用固定 `/usr/sbin/ioreg` 查询，匹配已知 Intel/AMD/NVIDIA 驱动的 PerformanceStatistics 字段。只按 IORegistry ID/精确 PCI 祖先关联名称和容量，白名单容量字段支持 CFNumber 或明确的小端 CFData；不把 Intel 集显的内存窗口当作显存。旧 NVIDIA 字段解析不意味着 macOS 13 上存在官方兼容驱动。此轮未做 macOS 真机验收。

GPU 查询只有一个有界后台工作者，超时缓存保留原始时间，超过 10 秒清空动态数值。外部工具统一登记，关闭时杀死并有界等待回收；Windows 使用采集器自身的 kill-on-close Job，Linux 保持创建线程并使用父退出信号，正常 EOF/信号/看门狗退出都清理自有查询。持续记录进程是显式脱离前台的独立资源，不能误放入查看连接的退出清理范围。单项不可读不会伪装为零，设备列表不代表支持每种温度或利用率指标。

## 0.3 持续记录

新增 stdio 方法 `recording.status`、`recording.configure`、`history.query`、`history.point`，固定字段与边界见 `shared/src/task-recording.ts` 和[产品协议](../../../docs/task-manager.md#持续监控与历史回溯)。配置启用为显式写入，带版本和操作 ID；读取状态不会启动记录器。默认 5 秒、7 天、256 MiB，先达到的留存上限生效。原始历史记录最多 40 个去重高占用进程与实际性能，不含进程命令行和环境；分段独立压缩并索引，查看最多 300 个代表采样点，再按 ID 读取单点。

记录目录与程序版本分开；停止持续监控保留历史，前台关闭、主密码锁定或插件退出不发送后台停止命令。后台不保存 SSH 凭据。目标重启或宿主系统清理用户进程会造成间断，本轮不自动修改开机项/linger/登录策略；状态必须区分设置启用与实际运行。

初始化和采集均在目标用户单实例锁内，单次预算 5 秒。系统调用卡住时只启动一个固定 `--record-recover` 后继进程，原进程退出并回收自有查询工具；恢复按 5 秒到 5 分钟退避，成功采样后重置。等待期间保持实例锁与启动中心跳，反复核对是否已停用；配置不可读时停止恢复，不堆积阻塞工作者。损坏记录分段跳过并报告缺口，不阻止停用或其他可读记录查询。

结束操作要求 PID + 创建时间与明确的 `force` 布尔值，并保护采集器、完整祖先进程链和系统关键进程。Windows 在同一个 OS 句柄上核对创建时间、查询 `IsProcessCritical` 并执行终止；Linux 先打开 pidfd，再核对身份并通过 pidfd 发送信号。动作只针对已确认的单个进程，无进程树扩展。返回值区分 `exited`、`pending` 与 `already-exited`；超时不自动升级强制结束。

## 已做的本机验收

2026-10-28 的最终 0.3.0 批次执行 `go test -count=1 -json ./...`，Windows 原生 54/54 通过（16 项记录器测试），六目标构建及摘要校验通过。记录器测试包含持久去重、版本冲突、启动锁、初始化期间停用、阻塞恢复、保留上限、损坏分段、时钟变化、缺口及后台独立运行。最终后端集成还实际验证了全部查看连接关闭后仍新增至少 3 条记录，重连能读旧采样，明确停用后进程退出且历史保留。HOME/USERPROFILE 均隔离，未修改用户运行数据；完整边界见[本轮验收](../../../docs/task-manager.md#性能与持续记录实施验证)。

2026-10-28 的 0.2.0 批次在 Windows x64 执行 16 项 Go 测试通过，包括独立逻辑核心编号与不同占用、CPU 平台计数语义、拓扑/计数器重置、设备消失重现、磁盘单位与时间跳变、GPU 输出边界和阻塞提供者回收，以及性能数据与进程合计 2 MiB 的编码边界。六目标产物构建并核对 SHA-256 通过。实际程序间隔约 1.1 秒采样，读取到 16 个不同占用的逻辑核心、4 个物理磁盘的真实吞吐/活动时间/总容量和按 LUID 识别的显示适配器；首个核心及磁盘样本全部保持 `null`。含 GPU 初次发现的完整快照约 496 ms，后续缓存快照约 16 ms。以上为本机单次观测，不代表其他设备性能或 Linux/macOS 实机验收。

2026-10-28 在当前 Windows x64 开发机执行 6 项 Go 测试，通过协议校验、请求上限、实际快照字节裁剪、stop / EOF / 短超时回收、真实快照与详情、身份不匹配及自身保护、专用测试子进程结束验证。只终止测试自己创建的子进程，未向真实服务器部署或执行进程动作。该批次约 214 个可读进程的首次快照 53 ms、缓存快照 19 ms；这是单次本机观测，不是跨平台性能保证。Linux、macOS 和 arm64 目前仅交叉构建，真实运行、权限差异和 macOS 分发签名仍待目标平台验收。
