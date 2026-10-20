# WebSocket 协议 v1

本文记录当前实现。一个页面一个 /ws 业务通道，每个 SSH 终端一个 /ws/terminal。HTTP 只提供静态页面、Cookie 与升级握手，没有 REST 业务 API。

## 本机访问

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

## 当前 RPC

| 方法 | 参数与结果 |
| --- | --- |
| auth.status | 查询当前本机会话是否有效；无配对方法 |
| catalog.watch | 返回 {subscriptionId,epoch,revision,snapshot}，初始化一致快照并订阅 |
| catalog.unwatch | 停止目录推送 |
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
| connections.open | {serverId,connectionId}，SSH 返回 sessionId/attachToken；RDP 返回 client-started |
| sessions.close | {sessionId}，关闭所属 SSH 会话 |
| sessions.hostKeyDecision | {sessionId,fingerprint,accept,verifiedChange?}，指纹变化接受时必须显式核验 |
| history.sessions | {serverId}，最近 100 个已保存会话 |
| history.open | {sessionId}，固定 lower/upper 范围，返回 id/capturedAt；每个业务连接一个快照 |
| history.page | {snapshotId,after?,search?}，返回 rows/after/done/incomplete |
| history.close | 幂等释放查询快照 |
| operations.get | {operationId}，查询成功、失败、执行中或未知 |

目录事件为 {v:1,type:'event',event:'catalog.changed',subscriptionId,epoch,revision,snapshot}，只向已订阅并仍授权的客户端发送已提交的完整快照。当前每次推送都带完整目录，因此版本跳跃可以直接用较新快照替换；不应用旧版本。重连重新 watch，不恢复事件回放。

配置 DTO 和校验在 shared/；所有普通配置响应均不含密码和私钥。当前没有通用 sessions.changed 主题，会话状态在各自终端通道发送。

全局状态事件为 `{v:1,type:'event',event:'vault.changed',epoch,status}`，只发送给会话有效且调用过 `vault.watch` 的页面；事件携带完整状态，无增量合并，重连重新订阅。`unlockMinutes` 是 0–525,600 的整数，0 表示服务运行期间永不过期；`expiresAt` 为当前解锁截止时间的 Unix 毫秒数，永不过期或未解锁时为 null。主密码和派生密钥不在状态中返回。默认 local，无首次选择流程。

页面先 watch 全局状态，解锁后才 catalog.watch。主密码锁定时业务请求返回 VAULT_LOCKED，仅允许全局状态查询/订阅、解锁，以及会话关闭、历史关闭、取消目录订阅等资源清理；目录推送暂停。后端到期计时器会主动清除密钥，每次请求也检查时间。锁定不关闭健康的 SSH 终端；重启后 master 模式一定锁定。

`catalog.replace.rdpPasswords` 为可选数组，每项 `{serverId,connectionId,secret}`。入口必须存在于本次提交的目录且类型为 RDP，同一入口不得重复；非空字符串设置密码，`null` 删除应用保存的密码，不提供此项则保持原密码。提交时遵循全局保存方式，设置了主密码则须已解锁。目录版本检查、目录与凭据写入在同一个事务中完成，提交成功后才推送公开目录快照，响应、订阅事件和导出不包含此参数或密码。RPC 操作去重同样适用，不自动重放失败未知的保存。

## 终端

首次消息 {type:'terminal.attach',sessionId,attachToken,cols,rows}；票据绑定拥有者、30 秒有效、仅使用一次。WS 建立后 10 秒内绑定；开始 SSH 连接后 120 秒连接/认证等待超时。最多 8 个 SSH 会话。

后端控制消息：terminal.hostkey（实际 SHA256 指纹与 previous/changed）、terminal.ready、terminal.notice、terminal.error、terminal.exit。指纹确认走业务 RPC。SSH 成功创建 PTY 后才发送 ready。

双向终端数据均为二进制原始字节，输出帧最大 16 KiB，未确认窗口 256 KiB。前端仅在 xterm.write 完成回调后发送 {type:'terminal.ack',parsedBytes}，累计原始字节严格单调、不得超过已发送字节；错误即断开。后端在窗口耗尽时暂停 SSH channel，受控队列总量超过 1 MiB 或长期未确认则结束会话。输入单帧 16 KiB、每秒 128 KiB，禁止自动重发。

尺寸变更：{type:'terminal.resize',cols,rows}，列 20–400、行 5–200。业务 WS 短暂断开不关闭健康的终端；终端 WS 关闭清理 SSH。网页刷新后创建新会话，不恢复旧 Shell。RDP 进程不随网页或后端关闭而被终止。

## 历史查询

快照 30 分钟有效，新打开或刷新替换旧范围，不订阅后续输出。每次扫描最多 400 块，返回最多 100 块、200 KiB 序列化正文预算；search 最多 256 个 UTF-16 单元。done:false 即便没有命中，也可以按返回的 after 继续查询。正文为纯文本，搜索返回命中行，跨存储块保留有限重叠文本。

前端仅保留当前页、至多 100 个翻页游标；关闭释放快照，迟到响应按代次丢弃。保留范围被清理时提示刷新；历史不写回实时终端，不进入浏览器持久存储。详见[历史设计](terminal-history.md)。

## 已验证与边界

集成测试覆盖鉴权、Host/Origin、导入、去重、目录订阅、主机指纹、密码/私钥认证、ACK、背压、跨重启保存与历史查询。尚未完成长时高并发、磁盘限额及 8 个高输出终端的容量验收。
