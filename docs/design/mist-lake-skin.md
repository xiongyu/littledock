# 雾岚湖畔 · 风景皮肤

生成方式：内置 image_gen（2026-10-26）。以下为实际提示词，图片直接使用原始 PNG，没有裁剪或二次绘制。

## 右侧工作区

```text
Use case: photorealistic-natural. Asset type: landscape wallpaper for the right workspace of a local server dashboard, theme named Mist Lake / 雾岚湖畔. Generate one beautiful landscape photograph, wide 16:9 composition, preferably 2560x1440. A tranquil mountain lake in early morning, blue-grey layered distant mountains dissolving into mist, soft silver sage-green water with a subtle reflection, small forested shore and fine evergreen trees at the far right edge and lower right corner. The horizon in the upper third, distant sunlit mist warm ivory but no visible sun disk. Sophisticated low saturation natural color palette: fog grey, eucalyptus, muted slate blue, gentle ivory. True photographic depth and believable subtle water ripples, no heavy blur, no oversharpening, no HDR. The central and left 70 percent should remain calm low-contrast open water and mist for readable interface cards placed on top. Landscape should still look appealing as a wallpaper without UI. Avoid dramatic dark silhouettes in the center, saturated teal or orange, bright glare, people, buildings, boats, text, typography, logos, UI elements, frames, borders, watermarks. Full-bleed opaque scenic image only.
```

## 左侧导航

```text
Use case: photorealistic-natural. Asset type: a narrow portrait scenic wallpaper for the LEFT sidebar of a calm desktop productivity application, part of the 'Mist Lake / 雾岚湖畔' theme. Create a real landscape photograph in a tall 1:3 aspect ratio, preferably 768x2304. A serene mountain lake shore at early morning in gentle pale mist, soft silver sage-grey lake water through the middle, distant blue-grey layered mountain ridges at the top, a few delicate evergreen trees rising from the bottom left edge with faint reflections at the bottom. Most of the top two thirds must be pale grey mist and quiet softly detailed landscape, suitable behind dark navigation labels. Subdued eucalyptus green, smoky blue-grey, warm ivory light, moderate soft contrast. Natural photographic detail, no heavy artificial blur, elegant and restful. It should coordinate with a wide wallpaper showing a still lake and a pine-covered right shoreline, without needing the two pictures to physically align. No dramatic sun, no saturated turquoise, no orange glow, no black silhouettes across the center, no people, no boats, no buildings, no text, no UI, no logo, no frame. Full-bleed opaque image.
```

## 资产

- [横幅湖景](../../frontend/public/skins/mist-lake/workspace.png)：1672 × 941，约 1.81 MiB。
- [竖幅山林](../../frontend/public/skins/mist-lake/sidebar.png)：724 × 2172，约 1.95 MiB。

配色：右侧底色 `#e8eeec`，左侧底色 `#dce4df`，强调色 `#48695c`。风景图使用 cover 保持比例，自动以中心构图显示；自上传图片继续沿用原来的拉伸行为。不增加裁剪或参数面板。

外观入口为右上角衣服图标，新增「雾岚湖畔」一键应用左右图片与配色。每侧可独立上传替换或移除；切换风景不会删除此前自上传图片，切回颜色预设时恢复之前上传的图片。默认安装仍为纯色预设。内置图随应用静态资源分发，仅保存选择标识；用户上传图仍只存在浏览器 IndexedDB。


## 验证

前端 TypeScript 检查与生产构建通过。浏览器已验证选择皮肤、两张本地静态图片加载、新页面恢复、单独移除左图后刷新仍保留右图、再次点击皮肤恢复两侧。390px 视口下无整页横向溢出，图片保持 cover 比例；浏览器没有警告或错误。实际页面效果截图存于仓库外，避免真实服务器资料进入项目资源。
