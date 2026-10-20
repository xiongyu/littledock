# 后端

Node.js 24 / TypeScript / Cordis 3.18.1。入口 src/main.ts；src/app.ts 装配具名服务。所有业务走本机会话 WS，页面自动建立会话，无配对步骤。HTTP 只提供页面及握手，设置主密码后统一解锁。

| 插件 | 职责 |
| --- | --- |
| storage | SQLite 目录、版本、事务、凭据行、主机信任和浏览器会话 |
| credentials | 可逆编码 / 可选主密码加密，后端读取私钥 |
| auth | 自动本机会话、Cookie 哈希与有效期、连接归属 |
| connectors / sessions | 注册 SSH，终端票据、主机校验、输入、输出、累计 ACK 和释放 |
| rdp-local / rdp-credentials | 已保存密码经 stdin 交给固定 Windows 凭据程序；临时 RDP 文件传递用户名，固定 mstsc.exe 启动，不接管进程生命周期 |
| terminal-history | 专用纯文本历史库、有限解析状态、固定范围查询与清理 |
| transport | Hono 静态资源、ws 升级、RPC 分发、操作去重和目录订阅 |
| ssh-import | 解析本机 SSH 配置，保留身份文件路径，不执行配置中的命令 |

运行、环境变量见[根 README](../README.md)。配置库 webnav.sqlite 和历史库 terminal-history.sqlite 存在用户数据目录。Windows 使用当前用户与 SYSTEM 的目录 ACL；普通导出不包含凭据、私钥、历史或浏览器授权。

历史默认 7 天、每会话 100 MiB、全局 1 GiB 文本负载；周期清理，剩余磁盘低于 100 MiB 时暂停保存并标记缺口。容量是实现限额，不是已压测吞吐或整个数据库文件的硬上限。

测试使用临时独立数据库、随机端口与本机模拟 SSH 服务器。运行 pnpm --filter @webnav/backend test，不读取真实私钥或连接真实服务器。详情见[WS 协议](../docs/websocket-protocol.md)、[凭据](../docs/credentials.md)与[历史设计](../docs/terminal-history.md)。

RDP 测试包含目录与密码事务回滚、主密码迁移与重启、模拟启动顺序及文件清理。Windows 上另外以随机 `.invalid` 主机名写入一条合成凭据，核对后立即删除，只操作本次测试条目，不建立远端连接。

全局设置测试覆盖默认免配置编码、所有 SSH/RDP 密码与私钥口令的迁移/轮换/移除、迁移失败整体回滚、按分钟固定有效期、多标签共享、锁定推送和重启失效。计时边界通过注入测试时钟验证，不改实际系统时间。
