# WebSocket 协议 v1

任务管理器使用现有业务通道 `taskManager.start/status/install/hostKeyDecision/snapshot/details/commandLine/prepareAction/applyAction/close`，不增加 HTTP 或终端通道。start 绑定本机或已保存的 serverId + connectionId，返回 monitorId；后续请求同时校验页面连接和监控归属。同 Cookie 多页面各自清理自己的监控。status/snapshot/details/commandLine 只读，其余要求操作 ID；计划绑定 monitorId、目标启动标识、PID、创建时间与 30 秒有效期，相同计划只执行一次，未知结果不自动重放。快照最多 10,000 个进程/2 MiB，详情每类最多 200 项。关闭业务 WS、锁定或关闭视图回收前台查看，不停止显式开启的独立记录器；远程查看计入八连接总额。完整格式与实际平台范围见[任务管理器](task-manager.md)。

采集器 0.3.1 增加 `taskManager.commandLine {monitorId,pid,startedAt}`，仅查询当前监控所属的单个进程。返回 `{pid,startedAt,commandLine,truncated,unavailable?}`；文本最多 32 KiB UTF-8，`commandLine: null` 必须同时给出 `permission` 或 `unavailable`，实际为空则为 `""`。原生读取前后复核身份，宿主再次验证返回身份；不缓存命令行，不进入快照、持续历史、日志、同步或公开插件上下文。旧采集器缺少 `command-line` 能力、替换提供者缺少该方法时返回 `UNSUPPORTED`，其他旧功能仍可使用。多选观察只使用现有快照；批量结束逐项复用 prepareAction/applyAction，不新增无确认的批量执行接口。

采集器 0.2 在协议 1 快照中增加可选 `performance`：`cpuLogical` 最多 4,096 项，`disks` 最多 64 项，`gpus` 最多 16 项，`unavailable` 最多 64 项。所有设备 ID 唯一，百分比范围 0–100，速率/字节数为非负有限数，未知为 `null`。GPU `memoryUsedBytes/memoryTotalBytes` 为专用显存，`sharedMemoryUsedBytes/sharedMemoryTotalBytes` 是可选共享系统内存已用/上限；不按主机 RAM 猜测上限，`utilizationScope: visible-clients` 明确只覆盖可访问进程。设备 `sampledAt` 保留真实采样时间，缓存不改写为当前时间。旧快照可省略性能字段；异常新快照触发监控停止与资源清理，不能继续显示就绪。

采集器 0.3 增加持续记录四个 RPC：`taskManager.recordingStatus {monitorId}`、`taskManager.configureRecording {monitorId,config,expectedRevision}`、`taskManager.queryHistory {monitorId,query}`、`taskManager.historyPoint {monitorId,id}`。仅 configure 是写入，WS 操作 ID 必须原样传到目标的持久去重记录；未知结果只读核对，不自动重放。config 为 enabled、intervalSeconds（1/2/5/10）、retentionDays（1/7/30）和 maxMiB（64–1024 整数），默认 5 秒、7 天、256 MiB。状态同时返回设置启用、实际 running/state、revision、最后采样、历史范围和字节数，运行记录器版本可与当前查看程序版本不同。

历史 query 为 `{from,to,maxPoints?}`，固定范围不超过 31 天，代表点不超过 300、缺口不超过 100；单点返回最多 40 个历史高占用进程和实际性能。历史 bootId 可以与当前不同，不能写入当前进程动作缓存。历史不实时追加、不进入浏览器持久化，部分统计和缺口保持原含义。关闭业务 WS、锁定或卸载只回收前台查看/SSH；已显式开启的目标后台记录器继续采样，只有 configure 的明确停用才停止，历史保留。

整包更新通过已鉴权且解锁的业务 WS 调用 `updates.status/check/download/cancel/install`。下载/安装携带候选 `targetVersion`；安装可显式传 `interrupt: true`，默认等待资源结束；三个副作用方法要求 `operationId`，由常驻控制层持久去重。网页不能指定 URL 或执行命令。状态返回模式、阶段、当前/目标版本、说明、进度、阻塞任务和恢复结果。查询仅访问本机状态，不触发 Gitee 请求；安装重启后重新连接查询。源码模式只提供不可更新状态。完整约定见 [在线更新](online-updates.md)。

新增 [MCP 工作台通道](mcp-implementation.md)：标准 stdio 连接器通过独立 /ws/automation 进行双向身份签名和受权工具调用；/ws/automation-terminal 使用页面 Cookie、精确 Origin、一次性观察票据显示同一 AI PTY。默认人工只读，手动接管使用控制代次与输入序号，观察者独立 ACK；观察断线不结束后台任务。业务 WS 增加 automation.settings/grant/pair/revoke/enabled/watch/attach/close，watch 返回完整快照和版本，事件为 automation.changed。HTTP 仍不提供 REST 业务接口。

SSH 辅助信息通过业务 WS 的 `ssh.system`、`ssh.files` 读取，详情与额度见[系统信息与文件栏](ssh-inspector.md)。不增加 HTTP API，不走终端输入通道。

本文记录当前实现。一个页面一个 /ws 业务通道，每个 SSH 终端一个 /ws/terminal，每个网页 RDP / VNC 一个 /ws/desktop。HTTP 只提供静态页面、Cookie 与升级握手，没有 REST 业务 API。

## 本机访问

浏览器扩展使用独立 `/ws/extension`，不放宽现有网页通道的 Origin/Cookie 校验。该通道仅接受扩展来源、一次性配对和后续双向认证，通过 HKDF / AES-GCM 加密顺序消息；允许 `matches`、`grant`、`fill`、`ping`、`saveTargets`、`saveBookmark`，没有普通业务 RPC 权限。`saveTargets` 只返回当前网站的收藏名称、ID、版本和是否有账密；`saveBookmark` 接收 `site/bookmark/expectedVersion/operationId/login?`，只保存当前网页来源的收藏，更新目标须同域名及端口；省略 `login` 保留已有账密。保存只返回 ID 与版本，不缓存请求或秘密，超时不自动重放。HTTP/HTTPS 共用完整域名匹配，非默认端口区分，详见[浏览器自动填写](browser-extension.md)。

管理页面新增 `extensions.status`、`extensions.beginPairing`（`name/masterPassword?`，需操作 ID，返回一次性配对码）、`extensions.cancelPairing`（`id`）、`extensions.revoke`（`id`）、`extensions.revokeGrant`（`id/bookmarkId`）。配对码不进入操作结果缓存，重复操作 ID 拒绝，不自动重放；其他管理写入使用正常操作去重。扩展凭据及填写结果不进入订阅或 `operations.get`。

仅监听 127.0.0.1，校验 Host 和精确 Origin。生产只允许当前服务 Origin；开发启动器允许配置的 Vite Origin（默认 http://127.0.0.1:5173）。页面响应自动建立 HttpOnly / SameSite=Strict 本机会话 Cookie，名称包含服务端口，用于识别 SSH 会话拥有者。

没有配对码或人工授权流程。有效本机会话默认 30 天，业务 WS 建立后直接查询状态与目录；若设置了主密码，须先统一解锁。旧版未完成配对的有效会话自动升级；不存在或过期的会话由页面响应重建。终端绑定仍校验拥有者和一次性票据。

开发入口的 HTML 请求通过 Vite 中间件取得后端的会话 Cookie，因此可直接打开 5173。握手失败时前端自动重新请求页面以补齐 Cookie，然后重连 WS；这不是 REST 业务接口。只有目录快照成功到达后才展示数量和空目录；此前显示“目录尚未加载”。连接中断保留本页快照并暂停目录操作。

## 信封与请求

服务发 hello：{v:1,type:'hello',epoch,authorized,limits}。epoch 是当前服务运行标识。

请求：{v:1,type:'request',epoch,id,method,params,operationId?}。
成功：{v:1,type:'response',id,ok:true,result}。
失败：{v:1,type:'response',id,ok:false,error:{code,message}}。

请求 ID 仅用于匹配响应。有副作用的方法必须带 operationId；相同拥有者、操作 ID 和内容返回原结果，不再次执行；内容不一致返回 OPERATION_CONFLICT。内容摘要使用进程随机密钥的 HMAC，记录最多 1,000 项，完成后保留至少 10 分钟，重启后失效。客户端超时或断线不自动重放写入、连接或终端输入。operations.get 可查询本次进程的操作状态，unknown 不表示失败。

业务连接最多 8 个并行请求、消息最大 2 MiB；服务最多 64 个 WS 连接，15 秒 ping/pong 检测断线。

配置同步使用独立的 HMAC 操作去重标记，不缓存含密码的请求正文或预览结果；重复请求返回 `SYNC_ALREADY_REQUESTED`，内容不一致返回 `OPERATION_CONFLICT`。上传候选和结果未知状态以密文持久保存，通过 `configSync.recover` 核对，不能在普通 RPC 超时后自动重放。详见[配置同步](config-sync.md)。

## 当前 RPC

| 方法 | 参数与结果 |
| --- | --- |
| auth.status | 查询当前本机会话是否有效；无配对方法 |
| configSync.status / watch | 读取状态；watch 订阅 configSync.changed，不推送解密快照或秘密 |
| configSync.configure / check | 保存平台、仓库、分支、空间编号和范围；check 只读检查访问，不上传 |
| configSync.unlock / lock | 同步账号密码仅本次解锁；锁定取消任务并清理密钥，不撤回已到达远端的提交 |
| configSync.preview / apply | 生成归属绑定的 5 分钟预览票据；apply 重新核验本机状态和远端版本后条件提交、事务应用 |
| configSync.history / recover | 有界历史分页；结果未知时核对原提交，retry:true 才允许在原条件仍成立时重送 |
| configSync.rotatePassword / confirmBinding | 重新加密当前快照；确认检查过新恢复入口的本机绑定 |
| catalog.watch | 返回 {subscriptionId,epoch,revision,snapshot}，初始化一致快照并订阅 |
| catalog.unwatch | 停止目录推送 |
| bookmarks.watch | 返回 {subscriptionId,epoch,revision,bookmarks} 并订阅；仅名称、网址、记录版本、hasLogin 与预览状态/时间 |
| bookmarks.save | {bookmark:{id,name,url},expectedVersion,login?}；新建版本 0，元数据与账密事务保存；login 的 username/password 缺省保留，null 清除 |
| bookmarks.remove | {id,expectedVersion}；删除元数据、缓存图与账密，取消任务 |
| bookmarks.refresh | {id}；排队刷新截图，返回公开快照 |
| bookmarks.thumbnail | {id}；按需返回 {capturedAt,dataUrl}，JPEG 最大 256 KiB |
| bookmarks.reveal | {id,version,masterPassword?}；主密码模式每次独立验证，返回 {username,password}；不缓存到 operations.get，不推送，不自动重试 |
| catalog.replace | {catalog,expectedRevision,rdpPasswords?}，事务提交，冲突拒绝覆盖；可携带最多 12 项 RDP 密码更新，与目录原子提交 |
| imports.preview | {catalog}，校验并返回 token、目录和警告 |
| ssh.importPreview | 读取本机 SSH 配置，返回 token、目录、别名数、私钥引用数与警告 |
| imports.apply | {token}，应用预览与凭据引用；5 分钟有效，目录改变时拒绝 |
| exports.config | 返回不含秘密的 JSON 文本及文件名 |
| vault.status / vault.watch | 返回 {configured:true,mode,unlocked,unlockMinutes,expiresAt}；watch 同时订阅全局状态 |
| vault.update | {mode:'local'或'master',password?,unlockMinutes}；原子迁移所有秘密或仅更新有效期，已启用主密码时省略 password 保持原值 |
| vault.configure / vault.changeMode | 兼容旧版 {mode,password?}；新界面只调用 vault.update，不要求首次配置 |
| vault.unlock / vault.lock | 主密码解锁 / 锁定，不关闭已认证的 SSH |
| credentials.describe | {serverId,connectionId}，只返回 kind/path/hasSecret 等描述 |
| credentials.save | SSH 独立认证保存：{serverId,connectionId,kind,path?,secret?}，不传 secret 保持已保存值 |
| connections.open | {serverId,connectionId}，SSH / 网页桌面返回 sessionId/attachToken，桌面另带 protocol；系统 RDP 返回 client-started |
| desktops.close | {sessionId}，关闭当前拥有者的网页桌面；操作 ID 去重 |
| sessions.close | {sessionId}，关闭所属 SSH 会话 |
| sessions.hostKeyDecision | {sessionId,fingerprint,accept,verifiedChange?}，指纹变化接受时必须显式核验 |
| history.sessions | {serverId}，最近 100 个已保存会话 |
| history.open | {sessionId}，固定 lower/upper 范围，返回 id/capturedAt；每个业务连接一个快照 |
| history.page | {snapshotId,after?,search?}，返回 rows/after/done/incomplete |
| history.close | 幂等释放查询快照 |
| operations.get | {operationId}，查询成功、失败、执行中或未知 |

目录事件为 {v:1,type:'event',event:'catalog.changed',subscriptionId,epoch,revision,snapshot}，只向已订阅并仍授权的客户端发送已提交的完整快照。当前每次推送都带完整目录，因此版本跳跃可以直接用较新快照替换；不应用旧版本。重连重新 watch，不恢复事件回放。

配置 DTO 和校验在 shared/；所有普通配置响应均不含密码和私钥。当前没有通用 sessions.changed 主题，会话状态在各自终端通道发送。

网页收藏单独推送 `bookmarks.changed`，带 `subscriptionId/epoch/revision/bookmarks` 完整公开快照，重连后重新 watch，忽略旧版本；截图异步完成也推送新状态。`bookmarks.save/remove/refresh` 使用操作去重；`bookmarks.reveal` 是仅返回当前请求的敏感读取，不能纳入去重结果或被 `operations.get` 取回。有主密码时即使页面已解锁也必须验证输入，验证后再次检查页面授权和全局解锁状态。账号密码不进入书签元数据、图片生成器或列表订阅。

全局状态事件为 `{v:1,type:'event',event:'vault.changed',epoch,status}`，只发送给会话有效且调用过 `vault.watch` 的页面；事件携带完整状态，无增量合并，重连重新订阅。`unlockMinutes` 是 0–525,600 的整数，0 表示服务运行期间永不过期；`expiresAt` 为当前解锁截止时间的 Unix 毫秒数，永不过期或未解锁时为 null。主密码和派生密钥不在状态中返回。默认 local，无首次选择流程。

页面先 watch 全局状态，解锁后才 catalog.watch。主密码锁定时业务请求返回 VAULT_LOCKED，仅允许全局状态查询/订阅、解锁，以及会话关闭、历史关闭、取消目录订阅等资源清理；目录推送暂停。后端到期计时器会主动清除密钥，每次请求也检查时间。锁定不关闭健康的 SSH 终端；重启后 master 模式一定锁定。

`catalog.replace.rdpPasswords` 为可选数组，每项 `{serverId,connectionId,secret}`。入口必须存在于本次提交的目录且类型为 RDP，同一入口不得重复；非空字符串设置密码，`null` 删除应用保存的密码，不提供此项则保持原密码。提交时遵循全局保存方式，设置了主密码则须已解锁。目录版本检查、目录与凭据写入在同一个事务中完成，提交成功后才推送公开目录快照，响应、订阅事件和导出不包含此参数或密码。RPC 操作去重同样适用，不自动重放失败未知的保存。

## 终端

首次消息 {type:'terminal.attach',sessionId,attachToken,cols,rows}；票据绑定拥有者、30 秒有效、仅使用一次。WS 建立后 10 秒内绑定；开始 SSH 连接后 120 秒连接/认证等待超时。最多 8 个 SSH 会话。

后端控制消息：terminal.hostkey（实际 SHA256 指纹与 previous/changed）、terminal.ready、terminal.notice、terminal.error、terminal.exit。指纹确认走业务 RPC。SSH 成功创建 PTY 后才发送 ready。

双向终端数据均为二进制原始字节，输出帧最大 16 KiB，未确认窗口 256 KiB。前端仅在 xterm.write 完成回调后发送 {type:'terminal.ack',parsedBytes}，累计原始字节严格单调、不得超过已发送字节；错误即断开。后端在窗口耗尽时暂停 SSH channel，受控队列总量超过 1 MiB 或长期未确认则结束会话。输入单帧 16 KiB、每秒 128 KiB，禁止自动重发。

尺寸变更：{type:'terminal.resize',cols,rows}，列 20–400、行 5–200。业务或终端 WS 断开只移除显示视图；SSH / 本地终端由后端继续持有。刷新后通过新票据接回原会话，终端先接收 `{type:'terminal.snapshot',cols,rows}` 和二进制当前状态，解析后再进入 ready。每次附着的网页累计 ACK 从零开始，后端解析与网页 ACK 独立。明确关闭或远端退出释放连接，后端重启不能恢复 Shell。系统 mstsc 仍不随网页或后端关闭而被终止。

后台工作区 RPC：`workspace.snapshot {}` 返回 `{epoch,revision,sessions,view}`，sessions 只含当前 owner 的非 AI 普通会话（身份、协议、名称及 connected），view 包含 groups / active / floating / minimized。`workspace.save {expectedRevision,view}` 要求操作 ID，使用版本检查和去重，后端内存保存有界布局引用。`sessions.attachTicket` / `desktops.attachTicket` / `devices.attachTicket {sessionId}` 验证归属及解锁，返回 `{sessionId,attachToken}`；票据随机、单次、三十秒，新票据替换旧票据。attach 不另建远端连接，新附件替换旧 WS 并拒绝其输入/ACK；不自动重放连接启动和输入。完整范围及第三方兼容见[后台会话](persistent-sessions.md)。

## 网页桌面通道

`/ws/desktop` 与业务 / 终端通道使用相同的回环 Host、精确 Origin、有效 Cookie 与心跳校验。首帧 JSON 为 `{type:'desktop.attach',sessionId,attachToken,width,height}`，宽 200–4096、高 200–2160；票据归属、30 秒有效期与单次绑定都在后端校验。无效票据或重放不会关闭原来的健康连接。建立 WS 后 10 秒内绑定，远端连接 / 认证限 30 秒。

后端认证 / 网关握手成功先返回 `{type:'desktop.bound',protocol:'rdp'|'vnc'}`；随后双向二进制：RDP 为 UTF-8 Guacamole 指令（客户端每帧须是完整 UTF-8 文本，可跨帧拆指令），VNC 为 RFB 字节流。VNC 的远端密码挑战在后端完成，浏览器只与本机认证后的代理协商 RFB 3.8 的 None 安全类型；不是让远端关闭密码。RDP 只允许 sync/key/mouse/size/clipboard/blob/end/ack/disconnect/nop 输入，不转发 select/connect 等连接设置。

绑定前的失败和 RDP 控制错误使用 `{type:'desktop.error',message,code?}`；VNC 绑定后不混入 JSON，错误通过关闭流结束客户端。客户端不得把 bound 当成远端已登录，只有客户端完成桌面初始化 / 同步后展示“已连接”。

RDP 一次刷新包含全部已合并的变化矩形，末尾只有一个 `sync`；前端须在本帧所有图片解码并绘制完成后回复相同序号。最多两帧等待确认，ACK 释放对应序号及更早的在途帧；无效序号拒绝。后端将等待期间的变化合并到当前画面，不排队旧截图。`img/blob/end` 可包含 JPEG 或 PNG，并可合在同一 WS 消息中；消息边界不等于指令或画面边界。浏览器增量解析器只保留未完成的指令，不能累积已处理文本。

每个 RDP `sync` 前可带 `webnav-frame,sequence,bridgeMicroseconds,paintCount,gfxFrameCount` 性能指令，四个值均为 uint32。`bridgeMicroseconds` 为此次本机刷新准备、编码及管道输出耗时；后两项是累计远端绘制更新数和 GFX 帧数。前端消费此指令，不交给 Guacamole，也不回传为输入；仅在含画面的 `sync` 完成实际绘制并发送 ACK 后计入 FPS。网页呈现耗时从本帧首张 `img` 指令到绘制 ACK，不能当成端到端输入延迟或远端游戏帧率。

RDP 证书变更在 bound 前发送 `{type:'desktop.certificate',requestId,host,port,previousFingerprint,fingerprint}`，客户端暂停普通连接等待，显示更新确认。用户的选择经当前桌面 WS 发送 `{type:'desktop.certificateDecision',requestId,accept:boolean}`；不接收客户端提供的新指纹或目标。后端校验页面归属、绑定 socket、解锁状态和当前待确认 ID，只消费一次。确认更新后保存新指纹并继续此次连接；取消保留原记录并停止。等待确认最多 120 秒，刷新后可接回同一请求且不延长期限，明确关闭或超时清理会话。证书不变或首次自动信任不发送此消息。

桌面输入单帧 64 KiB、每秒与 TCP 待写缓冲各 1 MiB，后端输出随 WS 发送回调暂停 / 恢复 TCP，WS 待发超过 4 MiB 移除视图。内置桌面 WS 关闭释放按下的输入并暂停显示发送，保留远端连接；新票据附着后生成完整画面。没有自动重放输入、录像或跨后端重启的连接恢复。旧提供者须声明 viewerVersion 1 才支持脱离后保留，详见[网页桌面](embedded-desktops.md)。

`catalog.replace.desktopPasswords` 使用与原 `rdpPasswords` 相同的 `{serverId,connectionId,secret}` 结构，支持 RDP / VNC；旧字段保留仅 RDP 的兼容性，不可同时提供两个字段。非空字符串设置、null 清除、省略保持；遵循全局主密码规则，与目录在同一事务内提交。RDP 保存密码要求用户名，VNC 不要求。字段不进入公开快照或导出。

## 历史查询

快照 30 分钟有效，新打开或刷新替换旧范围，不订阅后续输出。每次扫描最多 400 块，返回最多 100 块、200 KiB 序列化正文预算；search 最多 256 个 UTF-16 单元。done:false 即便没有命中，也可以按返回的 after 继续查询。正文为纯文本，搜索返回命中行，跨存储块保留有限重叠文本。

前端仅保留当前页、至多 100 个翻页游标；关闭释放快照，迟到响应按代次丢弃。保留范围被清理时提示刷新；历史不写回实时终端，不进入浏览器持久存储。详见[历史设计](terminal-history.md)。

## 已验证与边界

集成测试覆盖鉴权、Host/Origin、导入、去重、目录订阅、主机指纹、密码/私钥认证、ACK、背压、跨重启保存与历史查询。尚未完成长时高并发、磁盘限额及 8 个高输出终端的容量验收。

### 终端配色

terminalThemes.watch 返回 { subscriptionId, epoch, revision, defaultId, themes }，之后仅向该订阅推送 terminalThemes.changed 完整快照。terminalThemes.save 接收 { settings: { revision, defaultId, themes } }，属于有副作用 RPC，检查操作 ID、主密码解锁和当前 revision，提交后版本递增。每个方案为 { id, name, colors }，只接受完整的六位十六进制色值；最多 64 个自定义方案。服务重启或业务 WS 重连后重新订阅。

sessions.close / desktops.close 对已经释放的资源幂等返回；仍存在的资源继续检查 owner。显示通道断开后用户按 Enter，先查询后台并接回存活连接；后台已结束才创建新连接。已连接时明确选择重新连接仍先释放旧资源再创建新会话，保留工作区位置；不会因超时自动重放连接启动。独立显示页搬移不创建新 SSH，会保持原终端 WS 与累计 ACK。


## SSH 文件管理 RPC

### 远程编辑器 RPC

| 方法 | 参数 | 返回 / 语义 |
| --- | --- | --- |
| `editor.prepare`（写） | sessionId、folder | 异步任务状态；检查平台与安装记录，已有安装可直接启动 |
| `editor.install`（写） | id、acceptLicense（Windows 必须 true） | 安装到远端用户目录并启动；仅 needs-install 状态可调用 |
| `editor.status` | id | 所属任务状态、进度、平台、版本；ready 时包含本机页面 URL，不含令牌 |
| `editor.stop`（写） | id | 停止任务，释放代理、启动通道与临时文件；保留安装和编辑器数据 |

写方法携带 operationId，超时不自动重放。方法校验所属会话和主密码；准备/安装还校验 SSH 存活。客户端在面板打开时每 1.5 秒通过 WS 查询状态，状态范围见 [远程编辑器](remote-editor.md)。第三方编辑器自身 HTTP / WS 经独立回环代理，不作为 WebNav RPC 暴露。

### SFTP 文件 RPC

全部走已鉴权业务 WS，校验主密码和 sessionId 归属，不增加 HTTP 文件接口。完整限制与交互见 [SSH 文件管理](ssh-files.md)。标记“写”的方法须携带 operationId，超时不自动重放。分块方法用 transfer id 与精确 offset 保证顺序，位置不符终止传输。

| 方法 | 参数摘要 | 返回 / 行为 |
| --- | --- | --- |
| `files.cwd` | sessionId | 规范化 path、revision；尚未知目录时 path 为空 |
| `files.read` | sessionId、path | 512 KiB 内文本、encoding、bom、lineEnding、内容哈希 version；不进入操作缓存 |
| `files.save`（写） | sessionId、path、text、version、encoding、bom、lineEnding | 检查远端内容版本，暂存后替换；返回新 version |
| `files.action`（写） | sessionId、path、action；按操作提供 name、mode、ensure、confirm | properties / create / mkdir / rename / chmod / remove；删除必须 confirm=true |
| `files.begin`（写） | sessionId、path、kind=upload/download，上传有 size、overwrite | 返回 id、size、path；上传先写暂存文件 |
| `files.chunk` | id、offset，上传包含 Base64 data | 单块解码最多 128 KiB；返回累计 offset；下载另含 data、done |
| `files.commit`（写） | id | 完整上传后检查目标并提交，返回 path |
| `files.cancel` | id | 幂等释放所属传输、尽力清理暂存 |
| `files.startJob`（写） | sessionId、path、kind=compress/extract/external；external 有 editor=notepad/vscode | 返回异步任务 id |
| `files.status` | sessionId | 所属会话有界任务列表，含状态、进度、提示；本地编辑可含 localPath，不含文件正文 |
| `files.jobAction`（写） | id、action=retry/stop；确认冲突覆盖用 overwrite=true | 外部编辑重试或停止任务 |

文件正文及块不进入订阅、日志、配置备份或浏览器持久存储。任务状态每 2 秒按需读取，关闭文件栏停止轮询；已启动的本地编辑可继续回传，锁定 / SSH 关闭 / 服务停止则清理。下载结束即释放句柄；上传闲置 3 分钟回收。目录列表仍使用 `ssh.files` 有界分页，写入使其缓存失效。

## 插件 RPC

### 内置本地与设备连接

`connections.open` 同样接受已保存的 `local`、`adb`、`wdb` 入口。Local 返回终端票据并复用 `/ws/terminal`，关闭走 `sessions.close`。`plugin.builtin.adb.devices` 是已鉴权只读 RPC，返回本机 ADB 序列号、型号和授权状态；它不会替用户授权手机。

ADB / WDB 返回 `sessionId`、`attachToken`、`protocol`。浏览器连接 `/ws/device`，首包为 `{type:'device.attach',sessionId,attachToken}`；后端发送 `device.info`（编码 / 分辨率）、`device.ready`、`device.control`、`device.notice`、`device.reset`、`device.exit` 或 `device.error`。密码不进入这个通道。

视频二进制包为大端 uint32 序号 + PNG 或一组 H.264 包；H.264 每包为 uint64 标志 / 微秒 PTS、uint32 payload 长度与 Annex-B 数据。浏览器返回 `{type:'device.ack',sequence}` 累计确认；两包在途、16 MiB 总 payload 上限，虚假 / 倒退 ACK 关闭所属连接。

控制消息包括 `device.control`（enabled）、`device.visible`（visible）、`device.keyframe`、`device.release`（仅释放已按下输入）、`release_all`（释放且停止控制）；ADB 另有 `adb.touch` / `adb.tap` / `adb.swipe` / `adb.key` / `adb.text` / `adb.scroll`，由具体模式白名单校验。WDB 使用物理键鼠消息并保留 F8。`devices.close` 为操作 ID 去重的写 RPC，锁定后也允许幂等关闭。详见 [资源与协议边界](local-adb-wdb.md#通道与资源边界)。

### 外部插件

`plugins.state` 读取安装状态、运行提供者、内置本地说明、runtimeRevision 和 pending（id / kind / reason；kind 为 waiting、restart 或 error）。restartRequired 仅表示存在待重启项，不把活动连接等待误报成需要重启。`plugins.market` 读取或刷新索引；`plugins.details` 读取持久缓存的仓库说明、图标与清单。`plugins.assets` 返回运行修订号 revision、运行提供者 providers、当前运行前端入口与样式 assets。浏览器资源经已鉴权的 `/plugins/<id>/<commit>/...` 静态路由提供，不是 REST 业务接口；本次进程已经加载的旧前端版本保留访问，避免切换中的页面分块加载失败。

`plugins.watch` 返回 `{subscriptionId, epoch, state}`；运行实现或待处理状态变化时，仅向已订阅、已鉴权且解锁的业务 WS 推送 `plugins.changed`，携带 subscriptionId、epoch、revision。通知后读取 assets 与 state 完整快照，按插件提交 / 配置 / 提供者选择差异更新，不刷新整页。pending 变化也会通知，runtimeRevision 只在运行实现切换时增加；重连 / 重新解锁重新订阅并同步完整快照。正在等待切换的连接器拒绝新连接并返回 `PLUGIN_DRAINING`，已有连接继续直到主动结束。

`plugins.themes` 返回已安装的静态主题配色与背景地址，无需启用或重启；应用选择只保存在当前浏览器。静态路由也提供保留版本中明确声明的主题背景，升级或卸载不破坏已保存的外观；其余插件代码与数据不因此公开。

`plugins.prepare` / `plugins.install` 返回后台任务 ID，通过 `plugins.job` 查询进度和最终结果；任务按浏览器会话归属。安装需要预览 token、具体 commit、`acceptRisk:true` 与 expectedRevision。`plugins.change` 支持 enable、disable、select、configure、rollback、uninstall，并校验 expectedRevision。上述三个写方法使用 operationId 去重；超时不自动重放。

第三方 RPC 限定在 `plugin.<id>.<name>`，插件声明 mutate 后复用既有鉴权、解锁和操作去重。所有输入仍需运行时校验。插件不会得到绕过业务 WS 的 REST 管理接口。详见 [插件规范](plugins.md)。
