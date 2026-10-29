# scrcpy server 3.3.4

本目录随 WebNav 内置 ADB 插件分发官方 server；APK 格式的 Java 包以 `.jar` 名称保存，通过 `app_process` 临时运行，不安装到手机应用列表。

- 来源：[Genymobile/scrcpy v3.3.4](https://github.com/Genymobile/scrcpy/releases/tag/v3.3.4)
- 原始文件：[scrcpy-server-v3.3.4](https://github.com/Genymobile/scrcpy/releases/download/v3.3.4/scrcpy-server-v3.3.4)
- 本地文件：`scrcpy-server-v3.3.4.jar`，90,980 字节。
- SHA-256：`8588238c9a5a00aa542906b6ec7e6d5541d9ffb9b5d0f6e1bc0e365e2303079e`
- 许可证：[Apache License 2.0](LICENSE)，版权归原作者。
- 下载日期：2026-10-26。启动前校验 SHA-256，运行时不会自动下载或升级。

插件固定使用此版本的双通道和 12 字节视频帧协议。升级 server 必须同时核验版本参数、元数据、控制消息、视频头和清理流程，不能直接替换任意新版 APK。
