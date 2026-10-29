# WebNav 品牌标识

> 历史设计记录。当前品牌与标志见[小站 · LittleDock](littledock-brand.md)，本页保留原始 W 标志与生成过程。

生成方式：内置 image_gen，2026-10-26。最终资产为 [透明 PNG](../../frontend/public/brand/webnav-mark.png)，1254 × 1254，约 547 KiB。保留原始透明通道，没有裁剪、描摹或二次绘制。

## 设计

以 W 为主体，折线与留白表示相互连接的工作窗格，右上方箭头表示导航。采用厚实轮廓与轻微圆角，配合独立排版的 WebNav 字标；不增加副标题或额外说明文字。

侧栏用该透明图片的 alpha 作为 CSS 蒙版，颜色跟随侧栏文字色，适配纯色、风景和深色主题。标识盒为 38 × 38 px，字标随侧栏宽度在 17–24 px 间调整。点击继续返回工作台。浏览器标签页使用同一图形的原始深绿色图片。

## 验证

前端类型检查和生产构建通过。已在浏览器验证风景浅色、夜航深色、164 px 最窄侧栏（字标不溢出），以及点击标识从管理页返回主页；浏览器未报告警告或错误。截图仅包含品牌区域：[风景主题](screenshots/webnav-logo.png)、[深色窄栏](screenshots/webnav-logo-dark.png)。

## 实际提示词

```text
Use case: logo-brand.
Asset type: final standalone symbol for WebNav, a professional local web workspace that brings websites, SSH terminals and remote desktops together.
Primary request: design a premium, distinctive compact logo mark combining a clear geometric W monogram with the idea of navigating into a workspace. The W is built from confident broad architectural ribbon-like strokes; the final ascending stroke ends in a subtle northeast navigation point. Small deliberate negative-space openings suggest connected workspace panes. Make it feel like one coherent custom-designed identity, not a collage of icons.
Style: flat vector-like precision, sophisticated enterprise software branding, beautifully balanced geometry, a little optical rounding at outside corners, simple memorable silhouette. Works at 28–36 pixels. One solid deep eucalyptus ink (#31584b), with transparent cutouts.
Composition: one mark only, centered on a square transparent canvas, mark fills approximately 88 percent of the canvas, equal tight margins. No wordmark: WebNav text will be typeset separately in the interface.
Constraints: genuinely transparent alpha background; no text, no letters other than the abstract W form, no caption, no presentation board, no mockup, no enclosing app-icon tile, no 3D, no gradients, no shadows, no texture, no thin hairlines, no globe, no compass rose, no generic three overlapping squares, no copied brand identity. Clear powerful silhouette and clean scalable geometry are essential.
```

