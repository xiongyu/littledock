# 小站 · LittleDock 品牌与主题

产品名为「小站」，英文为 **LittleDock**，定位为「本地连接与工具工作台」。2026-10-29 选定五版探索中的 **5 号水獭管家**作为主标志和后续吉祥物形象：水獭抱着带连接接口的终端工具箱，表达亲切、可靠的本地工具工作台。保留焦糖与奶油色毛发、圆耳、略挑的眉毛、青色外套和橙色内衬；后续表情和动作延展沿用这些特征。中文界面使用「小站」主字标和 LittleDock 副字标，英文界面使用 LittleDock。

## 交付资源

2026-10-29 使用内置 imagegen 工具生成品牌与背景 PNG。水獭完整图直接采用已选定的原图，另以它为参考生成头像版；保留原始输出与透明通道。完整图和头像均为 1254 × 1254（RGBA），工作区背景为 1672 × 941，侧栏背景为 724 × 2172。五版探索与完整图提示词见[设计探索](logo-explorations-2026-10-29/README.md)。以下路径均相对仓库根目录。

| 资源 | 文件 | 用途 |
| --- | --- | --- |
| 水獭管家完整图 | [littledock-otter.png](../../frontend/public/brand/littledock-otter.png) | 当前主标志；侧栏、自动填写扩展弹窗，及后续吉祥物参考 |
| 水獭头像 | [littledock-otter-icon.png](../../frontend/public/brand/littledock-otter-icon.png) | 浏览器标签、扩展图标和 Windows 托盘的小尺寸显示 |
| LD 码头标志 | [littledock-mark.png](../../frontend/public/brand/littledock-mark.png) | 已停用的前版设计，保留历史资源 |
| 小站亭子标志 | [littledock-station.png](../../frontend/public/brand/littledock-station.png) | 备选设计，未启用 |
| 晨雾小港 · 工作区 | [workspace.png](../../frontend/public/skins/harbor-dawn/workspace.png) | 浅色横向背景 |
| 晨雾小港 · 侧栏 | [sidebar.png](../../frontend/public/skins/harbor-dawn/sidebar.png) | 浅色竖向背景 |
| 暮色归港 · 工作区 | [workspace.png](../../frontend/public/skins/harbor-dusk/workspace.png) | 深色横向背景 |
| 暮色归港 · 侧栏 | [sidebar.png](../../frontend/public/skins/harbor-dusk/sidebar.png) | 深色竖向背景 |

网页侧栏使用满宽、淡主题色的圆角品牌底板，常规宽度以 72px 显示完整水獭，中文主字标最大 28px；窄侧栏自动将图形缩至 40px，英文名称同步缩小，底板与导航之间留 18px。扩展弹窗以 40px 显示完整水獭，均使用真实彩色图片，不以文字色蒙版覆盖。16–32px 等小尺寸位置使用聚焦脸部的头像图。托盘随 Windows 启动器分发同一头像，运行时绘制浅色底与绿/黄/红状态点；不读取用户文件。旧版 W、LD 标志和「雾岚湖畔」资源保留为历史记录与兼容预设。此轮没有增加吉祥物动画或自动打扰用户的交互。

## 默认与兼容

没有已保存外观时，按系统明暗选择「晨雾小港」或「暮色归港」。两个区域分别提供移除背景和上传图片/视频；移除后使用该侧纯色。视频支持浏览器可解码的 MP4 / WebM（≤ 50 MB、约 830 万像素），静音循环，页面隐藏暂停，恢复可见后继续。背景以 Blob 保存在当前浏览器；已有图片无需迁移。切换内置风景不会删除已上传图片，恢复默认会删除两侧上传媒体并恢复当前系统对应的新主题。本轮生成的默认风景仍为静态图片，动态背景由用户上传视频。原有纯色、雾岚湖畔、插件主题与左右独立设置仍按原偏好加载，不因品牌更新覆盖。

此次更名仅改变品牌展示。已有 `WebNav` 数据与应用配置目录、`WEBNAV_*` 环境变量、`@webnav/*` 包作用域、`webnav.plugin.json`、插件 ID、加密格式、页面 Cookie、WS 协议、浏览器存储键与扩展配对身份保持不变。便携包新增 `LittleDock.vbs` 展示入口，同时保留 `WebNav.vbs` 与 `Start-WebNav.ps1` 兼容入口；不迁移用户数据或重置单实例配置。

## 水獭定稿与品牌区验证（2026-10-29）

- 完整水獭与选定的 5 号原图 SHA-256 一致，前端与托盘头像副本 SHA-256 一致；原图、探索方案与头像提示词均保留。
- Chrome / Edge / Firefox 扩展构建、前端类型检查与生产构建通过；Windows 原生托盘回归 1 项通过。构建保留已有的 jmuxer stream 外置和大分块提醒。
- 隔离 Edge 外观验收通过：中英文品牌、明暗主题、最窄 164px 侧栏的英文名称、390px 布局与移动导航关闭；已有图片/视频上传、循环、刷新恢复与旧偏好检查同时通过。仅使用临时空目录，未重启日常实例。
- 实际检查 16/24/32/48px 头像在明暗底色上的显示，扩展弹窗只做静态标题布局预览，本批没有重跑扩展配对与填写流程。

预览：[放大的品牌区](screenshots/littledock-brand-header.png)、[头像尺寸](screenshots/littledock-otter-icons.png)、[扩展标题](screenshots/littledock-extension-header.png)、[最窄侧栏](screenshots/littledock-narrow-sidebar.png)。下列整页截图已更新为水獭定稿后的界面。

## 初版品牌与背景验证（2026-10-29，水獭定稿前）

- 整包 `pnpm build` 通过（含共享层/后端 TypeScript 与前端 vue-tsc）；另跑扩展类型检查通过。保留原有 Vite 包体积和 jmuxer stream 外置提醒。
- 本批前端测试 73 项、扩展测试 2 项、后端开发入口/插件相关测试 16 项、Windows 托盘测试 6 项通过。托盘使用隔离用户配置，未改变用户日常启动项或服务。
- `backend/tests/appearance-browser.mjs` 在隔离空目录和 Edge 中通过：明暗首次默认、主题切换/刷新、单侧移除、上传图片保留与恢复默认、旧纯色/雾岚湖畔偏好、中英文和 390px 无横向溢出。
- 使用浏览器内存中生成的短视频验证实际 MP4/H.264 与 WebM 解码、静音播放及刷新恢复；WebM 连续跨过两个循环边界；模拟 visibilitychange 的隐藏/恢复状态验证暂停与继续；损坏视频保留原背景，切换风景卸载播放器、切回纯色恢复上传视频，重置清理媒体。测试短片没有写入仓库或用户数据。其他浏览器、编解码器以及长时间播放的 CPU/GPU/内存占用未专项验收。
- 语言目录、插件控件目录、相关文档链接及 `git diff --check` 通过。本轮未发布正式安装包，在线更新/签名完整流程沿用原机制，未重做整包升级验收。

实际页面：[晨雾小港](screenshots/littledock-dawn.png)、[暮色归港](screenshots/littledock-dusk.png)、[英文](screenshots/littledock-english.png)、[窄屏](screenshots/littledock-mobile.png)。

## 动态背景测试片（2026-10-29）

已保存 [暮色归港循环视频](videos/harbor-dusk-loop.mp4)：8 秒、1280 × 720、24 fps、H.264 / yuv420p、无音轨，835,920 字节（约 816 KiB）。由已有 imagegen 湖畔背景经本地 FFmpeg 制作周期性水纹与轻微画面移动；不是新调用视频生成模型。位移周期为 8 秒，右侧码头区域减少水面变形。

通过真实外观上传入口，在临时目录与独立 Edge 浏览器中验证此文件：连续跨过 2 个循环边界（384 次视频帧回调），静音自动播放、刷新恢复、模拟页面隐藏/恢复、左右独立上传与移除均通过，无页面异常。抽样解码确认有实际运动；首末帧水面区域平均通道差为 1.045 / 255，相隔 2 秒为 2.377 / 255。这里只验证播放与接缝，没有做长期资源占用测量。

- [工作台中的实际效果](screenshots/littledock-video.png)
- [第 2 秒预览帧](videos/harbor-dusk-preview.png)
- [本批验证结果](videos/harbor-dusk-validation.json)
- 生成入口：`node scripts/render-background-video.mjs`（本机需有 FFmpeg；不会覆盖已存在的输出）。
- 验证入口：先构建前端，再在 `backend/` 执行 `node --experimental-strip-types tests/background-video-browser.mjs`。

测试片保存在设计资源目录，不自动安装到日常工作台，也不覆盖已有背景。外观设置选择「右侧工作区」后上传该 MP4 即可使用。

## 水獭头像生成提示词

以已选定的 `logo-explorations-2026-10-29/05-otter-keeper.png` 为唯一参考，使用内置 imagegen，`transparent_background: true`；完整水獭图保持原样。

```text
Use case: identity-preserve / logo-brand. Edit target: the attached approved otter mascot image for LittleDock / 小站. Create its official SMALL APP ICON companion, using exactly the SAME otter identity, warm caramel and cream fur, dark navy outline, small round ears, forehead tuft, expressive brown eyes, raised eyebrow, rounded nose, friendly self-assured smile, teal worker jacket with orange lining, and illustrated rendering style. Change composition ONLY to a tight head-and-shoulders portrait: the face fills most of a square canvas, a little teal and orange collar is visible at the bottom, no hands, no terminal toolbox, no tail. Keep the same gaze direction, expression and proportions; it must obviously be this character, not a redesigned otter or another species. Use a stronger clean outer silhouette and slightly more grouped fur detail so eyes/nose/cream cheeks remain legible when reduced to 16–32 px. Keep expressive colorful character artwork, do not turn it into minimalist flat geometry. Center with balanced clear margins, ears and whiskers contained, about 88 percent occupancy. Genuinely transparent background. No badge, no circular or square tile, no text, letters, numbers, border, ground shadow, mockup, or watermark. One portrait only.
```

## 初版标志与背景生成提示词

每项调用一次内置 `image_gen`，两款标志设置 `transparent_background: true`，四张背景为不透明图片。

### logo-dock

```text
Use case: logo-brand. Asset type: production standalone transparent app symbol for LittleDock (Chinese product name 小站), a calm local connection and tools workspace. Create ONE distinctive geometric symbol: a sturdy rounded L-shaped pier cradled by an open D-shaped harbor, the deliberate central negative space suggesting a welcoming workstation berth. The L and D must feel like one compact balanced silhouette, not two typed letters. Quiet, confident, approachable tool identity, subtle rounded corners, wide strokes, excellent recognition at 16–32 pixels. Flat single solid eucalyptus dark green #31584b only, transparent negative spaces and genuinely transparent background. Square canvas, symbol occupies about 86 percent with balanced clear margins. No wordmark, no text, no caption, no presentation grid, no app-icon background tile, no gradients, no shadows, no mockup, no thin lines, no anchor, no power-button shape, no copied identity. Final raster logo asset, crisp vector-like edges.
```

### harbor-dawn-workspace

```text
Use case: photorealistic-natural. Asset type: production wallpaper for the wide right workspace of LittleDock / 小站, a personal local connection and tools dashboard. Create a beautiful restrained landscape photograph, wide 16:9, ideally 2560x1440. A small sheltered mountain lake harbor at dawn, pale sage silver water, eucalyptus forest, layered slate-grey distant ridges softened by light morning mist. A short simple wooden landing pier occupies only the extreme lower right, unobtrusive and human-scale. Quiet lake and mist occupy the central and left 80 percent for readable interface cards. Horizon near upper third, subtle warm ivory morning sky, realistic restrained ripples and natural detail. Cohesive palette #e8eeec, #dce4df, muted forest green, pale stone, desaturated blue grey. Gentle low contrast, calm and welcoming, not dramatic. No people, vehicles, text, logos, UI, frames, watermarks, saturated teal/orange, hard sun, large buildings or heavy blur. Opaque full-bleed scenic image, not a mockup.
```

### harbor-dusk-workspace

```text
Use case: photorealistic-natural. Asset type: production DARK wallpaper for the wide right workspace of LittleDock / 小站, a local connection and tools dashboard. Wide 16:9 landscape photograph ideally 2560x1440. Sheltered forest lake harbor at blue hour just after sunset. Muted deep green-grey lake, dark slate mountains dissolving into evening haze, overcast deep blue-green sky. A modest wooden landing pier and tiny warm amber dock light only at the extreme lower right edge, no visible light flare. The center and left 80 percent are calm dark low-contrast open water and haze, appropriate behind light interface text. Overall luminance consistently low, refined natural photographic detail, gently perceptible ripples. Palette charcoal eucalyptus #202c29, deep slate #243239, muted pine #1a2622, one very small soft amber detail. Peaceful, grounded, inviting. No people, boats, dramatic stars, moon disk, neon, saturated colors, logos, words, UI, frames or watermarks. Full-bleed opaque wallpaper only.
```

### logo-station

```text
Use case: logo-brand. Asset type: alternative transparent application symbol for 小站 / LittleDock, a personal local connections and tools workspace. One extremely simple compact friendly geometric pictogram: a small open-sided station shelter above a short landing pier, suggesting a welcoming little stop and a place for connections to dock. Strong silhouette with a gently pitched roof, two broad side posts, and a single horizontal platform extending right. Deliberate negative space forms an open doorway. Refined modern utility identity, recognisable at 24px. Single flat dark eucalyptus green #31584b, transparent negative space and genuinely transparent canvas. Square canvas, icon about 84 percent, generous balanced margins. No text, letters, caption, grid, background tile, mockup, shadow, gradient, trees, anchor, thin details or watermark. Crisp vector-like raster production logo.
```

### harbor-dawn-sidebar

```text
Use case: photorealistic-natural. Asset type: tall left navigation sidebar background for 小站 / LittleDock, calm local connection workspace. Portrait 1:3, ideally 768x2304. A quiet sheltered mountain lake at dawn, pale sage silver water and ivory mist, distant low ridges in the upper quarter. Gentle eucalyptus-green forest edge only in the lowest right corner, tiny unobtrusive wood landing pier at the very bottom. Upper 75 percent very calm softly luminous low-contrast water and haze behind dark sidebar labels. Restrained realistic natural photo. Palette pale #dce4df #e8eeec, desaturated forest greens, stone, silver. No people, buildings, boats, logos, text, UI, frames, watermarks, saturated colors or hard sun. Full-bleed opaque wallpaper.
```

### harbor-dusk-sidebar

```text
Use case: photorealistic-natural. Asset type: tall DARK left navigation sidebar wallpaper for 小站 / LittleDock, a personal local connections workspace. Portrait 1:3, ideally 768x2304. Quiet forest lake at blue hour, deep muted green-grey water, soft slate mountain silhouettes under deep overcast green-blue sky. Upper 75 percent calm uniformly dark low-contrast water and haze, allowing light navigation labels. Lowest right corner shows a subdued close shoreline and a small wooden pier corner with one tiny warm amber dock lamp. Natural restrained photographic detail, gentle ripples, charcoal eucalyptus #202c29, slate #243239, pine #1a2622. Peaceful welcoming nocturnal scene. No stars, moon disk, people, boats, text, logos, UI, frames, watermarks, strong reflections, saturated blue or neon. Full-bleed opaque wallpaper.
```
