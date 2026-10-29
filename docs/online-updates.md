# 工作台正式版与在线更新

整包更新由常驻单实例 supervisor 管理，网页入口是「全局设置 → 工作台更新」。源码模式明确显示不可在线更新。插件自身继续使用[插件中心](plugins.md)的提交绑定、资源等待与在线切换。

## 使用与行为

- 正式版解压后双击 `WebNav.vbs`，使用包内 Node，不依赖电脑上的 Node、pnpm 或源码。`Start-WebNav.ps1 -Console` 保留前台诊断。
- 每用户只运行一个工作台，重复运行打开原实例网页。首次从源码迁移须先退出旧实例；默认数据位置不变，自定义目录通过 `WEBNAV_DATA_DIR` 保留。
- 只自动检查，下载和安装由用户触发。关闭网页、关闭面板、普通退出不会额外触发安装。
- 下载可取消。安装默认等待 SSH、本地终端、桌面、设备及插件/AI 资源结束，同时阻止新任务；取消等待恢复接收任务，下载包保留。
- 可明确选择结束现有连接与任务；已接收的 RPC、文件写入、插件安装/清理、配置同步、截图仍须完成。独立的系统 mstsc 不属于工作台，不能顺带终止。
- 安装期间网页断线，新进程就绪后自动重连。旧 Shell 不因重启恢复。新版启动失败且数据格式相同时恢复旧代码，保留原数据库，不用旧数据库覆盖新数据。
- 开机启动仍需用户勾选。已有自启项迁移到稳定入口及包内 Node，保留端口、数据目录；未勾选时不创建。更新不把自启指向可被淘汰的版本目录。

## Gitee 源与访问频率

正式源采用 `https://gitee.com/axisxy/webpagenav/releases` 普通发行版页面。一次 HTML 请求提取发行说明代码块中的 `WEBNAV_UPDATE_V1:<base64>`，随后验证签名；不调用 Releases API 或 raw 接口，不执行网页脚本，不读取用户浏览器登录状态。

- 基础周期 6 小时、±20% 抖动；失败指数退避到最多 24 小时。下次检查时间落盘，反复启动不会反复请求。
- Gitee 手动检查至少间隔 5 分钟，在途检查合并；间隔内返回缓存。保存 ETag / Last-Modified，304 复用已验证清单。
- 403、429、503 暂停请求，遵守 Retry-After，最少等待 5 分钟，无有效值时等待 1 小时。等待跨重启保留，下载也不能绕过。
- 页面最多 2 MiB、40 条标记，只选签名有效、未过期、匹配系统/架构和渠道的最高版本。登录页、验证页、无签名内容不能变成候选。
- 包地址绑定该仓库 `/releases/download/` 路径。最多 3 次跳转，仅允许已核对的 HTTPS `gitee.com` → `foruda.gitee.com` 链路，不转发 Cookie/认证。站点改变下载域名时停止并提示，不自动扩大信任范围。
- 缓存和退避减少请求，不能保证站点永远不限流。

2026-10-27 已只读核对本仓库页面返回 200，并用公开项目的小附件验证跳转链路，未在本仓库发布测试附件。普通仓库单附件上限 100 MB、附件总容量 1 GB，见 [Gitee 官方说明](https://help.gitee.com/repository/release/create)。脚本按保守的 100,000,000 字节校验每个包；发布者仍需管理仓库总容量。

## 安装布局

```text
WebNav/
  WebNav.vbs / Start-WebNav.ps1 / launch.mjs
  runtime/node.exe / initial.json    # 固定控制层运行时与初始摘要
  launcher/windows/                 # 固定托盘、自启引导
  installation.json                 # current / previous / pending
  update-source.json                # 公开地址、公钥、渠道
  releases/<version>/
    release.json / runtime-dependencies.json
    runtime/node.exe
    backend/                        # 构建、生产依赖、内置插件、RDP 组件包
    frontend/dist/                  # 含浏览器扩展下载包
  updates/                          # 下载、暂存、操作记录
```

数据库、历史、凭据留在既有用户数据目录，不进入发布包。便携 ZIP 只保存一份 Node，首次启动校验摘要并原子复制到初始版本目录，避免重复压缩导致超过附件限制。后续更新包自带完整运行时。最低启动器版本或数据格式不兼容时拒绝在线切换，须使用完整包和迁移说明。

成功后保留当前和上一版，只清理有匹配发布元信息的更旧目录、旧包与中断暂存。文件占用导致清理失败不回退成功版本，下次启动重试。源码与用户数据不在清理范围。

## 发布

脚本面向 Windows x64、Node.js 24。依赖按锁文件安装，再把生产依赖图复制成普通文件，不依赖 pnpm 链接或开发依赖。包内 SQLite/PTY 通过实际启动验收。Git、ADB、远端编辑器包等可选外部组件仍遵循各插件的安装要求。

私钥只生成一次，存于仓库外受限目录并离线备份；后续发布复用同一私钥。网页不能自动替换信任公钥。下面是示例路径与版本：

```powershell
pnpm install --frozen-lockfile --prod=false
pnpm typecheck
pnpm test
pnpm release:keygen --key E:\WebNavReleaseSecrets\update-ed25519.pem
pnpm release:build --version 0.1.0 --output .releases\0.1.0 --feed https://gitee.com/axisxy/webpagenav/releases --key E:\WebNavReleaseSecrets\update-ed25519.pem --notes E:\WebNavReleaseSecrets\release-notes.txt
```

构建默认先运行 `pnpm build`，拒绝覆盖输出目录；`--skip-build` 仅用于已构建的流水线。产物包括更新 ZIP、便携 ZIP、`feed.json`、`release-description.md`、公开源配置和 `publish-plan.json`。脚本不提交代码、推送标签或上传附件，清单明确 `uploaded: false`。

1. 在与包内代码对应的已审查提交上创建 `v<version>` 发行版。
2. 上传两个不可变 ZIP，保留文件名，不提交二进制到 Git 或覆盖既有版本。
3. 确认附件可下载后，把生成的 `release-description.md` 完整放入发行说明。签名标记最后发布，避免客户端先看见尚无附件的更新；普通说明可改，标记不可手改。
4. 从公开页面核对版本、签名、下载并用测试安装验收，再分发便携包。预发布版使用 `--channel preview` 与带预发布标识的语义版本。

清单签署版本、平台、架构、数据格式、最低启动器、长度、SHA-256、说明及时间，使用 Ed25519 对带 `webnav-update-v1` 域分隔的原始 JSON 签名。有效期默认 90 天；长期无新版时须重新签发同一不可变包的有效清单。也支持独立 HTTPS JSON 源和明确的 `http://127.0.0.1` 隔离测试源，不接受其他明文 HTTP。

## 切换与恢复

安装前重新核对目标、有效期和包摘要。解压拒绝路径穿越、大小写重复、Windows 保留名、链接、特殊/加密文件；限制压缩包 1 GiB、解压 2 GiB、100,000 条目，检查磁盘空间。下载无进展 60 秒超时，清单检查总超时 20 秒。

业务进程内完成任务检查和最后禁止新请求；supervisor 等待 Cordis 清理确认及实际进程退出，才原子写入 `pending`。新版须回报本次随机 nonce 和精确版本，仅端口可访问不算就绪。就绪前失败恢复旧版，就绪后清除 `pending`。

中断留下 `pending` 时，下次固定入口先加载旧控制层，核对双方数据格式后恢复。这里只模拟中断记录，不保证所有硬件断电或文件系统损坏都可恢复。失败会明确报告，不并行启动两个业务进程。副作用使用最近 100 个持久操作 ID 去重，未知结果通过状态查询确认，不自动重装。操作日志损坏时工作台仍可启动，但暂停更新，防止去重信息丢失后重放。

更新源损坏可修复公开配置后重启。操作记录损坏时，先退出，备份 `updates/` 与 `installation.json`，核对当前/待恢复指针后人工修复，不直接重放旧安装请求。没有数据库自动降级或不可逆迁移路径。

## 验证边界

2026-10-27：类型检查、生产构建、全量 186 项测试通过（后端 142、前端 42、扩展 2）；独立发布包验收通过。Gitee 格式更新包约 84.6 MB、便携包约 84.7 MB，均小于普通仓库单附件限制。

`backend/tests/updates.test.mjs` 覆盖签名/有效期/来源、下载损坏、并发检查、等待和取消竞争、持久去重、写入收尾、旧进程关闭失败、新版恢复、解压攻击、数据兼容、清理、Gitee 页面和跨重启限流。

```powershell
pnpm test:updates:installed .releases\0.1.0\WebNav
```

独立验收使用临时安装、隔离用户配置、合成目录和本机更新源，实际启动包内 Node、SQLite、本地 PTY；验证 `0.1.0 → 0.1.1`、网页重连、数据保留、重复安装、错误 nonce/失败进程恢复、中断指针恢复。浏览器覆盖下载、等待活动终端、取消及 390px 布局；自启使用隔离 Startup 目录，验证旧快捷方式迁移和真实隐藏引导启动更新后的版本。

本轮包使用临时测试签名密钥，不能直接作为公开正式发行版上传。未发布 Gitee 正式附件，未实际注销/重启 Windows，未连接真实远端验证更新期间的 SSH/RDP/VNC。已实现磁盘空间检查，未耗尽磁盘做破坏性验收。
