# 规则依据与第三方边界

核对日期：2026-10-28。执行器、UI 和恢复流程为本项目实现；没有捆绑或执行 WinUtil、Win11Debloat、BleachBit、Autoruns 等第三方优化程序，也没有导入 GPL 清理规则。

参考 Win11Debloat 的设置项命名和公开注册表规则，核对时 master 提交为 `ea20885fbe9fc16c04ddb9c054f8be1d47ec6d7b`（MIT）。本包仅列出选定项的注册表位置和数值，不执行其整套脚本：

- [Windows 建议设置](https://github.com/Raphire/Win11Debloat/blob/ea20885fbe9fc16c04ddb9c054f8be1d47ec6d7b/Regfiles/Disable_Windows_Suggestions.reg)：资源管理器同步建议、开始建议、使用提示、更新欢迎、设置建议及设备设置提醒。
- [透明效果](https://github.com/Raphire/Win11Debloat/blob/ea20885fbe9fc16c04ddb9c054f8be1d47ec6d7b/Regfiles/Disable_Transparency.reg)：当前用户 EnableTransparency。
- [项目功能说明](https://github.com/Raphire/Win11Debloat/wiki/Features)：资源管理器位置、扩展名及隐藏文件。

Windows 官方接口依据：

- [Run / RunOnce 注册表语义](https://learn.microsoft.com/en-us/windows/win32/setupapi/run-and-runonce-registry-keys)：保留 RunOnce，只停用支持的普通 Run 登记。
- [启动应用与启动文件夹](https://support.microsoft.com/en-us/windows/experience/startup-boot/configure-startup-applications-in-windows)：只读枚举两类来源，未声称覆盖全部开机执行点。
- [文件夹显示设置](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-gppref/3c837e92-016e-4148-86e5-b4f0381a757f)：扩展名、隐藏文件的注册表位置。
- [RegistryKey.GetValue](https://learn.microsoft.com/en-us/dotnet/api/microsoft.win32.registrykey.getvalue)：读取 ExpandString 时保留未展开的原始内容和精确类型。
- [ProtectedData](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.protecteddata)：恢复材料采用 Windows 当前用户 DPAPI。
- [Windows 设置 URI](https://learn.microsoft.com/en-us/windows/apps/develop/launch/launch-settings)：仅开放固定的启动、应用、存储页面，不能传入任意 URI 或卸载命令。

规则与助手文件一起固定 SHA-256；改变规则必须重新构建发布。注册表写入成功不等于所有 Windows 构建都会呈现相同界面效果；本首版只做读取与模拟写入验收，实际效果仍需在一次性 Windows 测试用户或虚拟机中补测。
