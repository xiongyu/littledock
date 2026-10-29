// Isolated brand/theme acceptance; never reads the user's running profile or connects remote targets.
import assert from 'node:assert/strict'
import { access, mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { chromium } from 'playwright-core'
import { platformFixture } from './plugin-platform-fixture.mjs'

const fixture = await platformFixture(), screenshots = resolve('../docs/design/screenshots')
let browser
const errors = []
try {
  await mkdir(screenshots, { recursive: true })
  let executablePath
  for (const path of ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe']) {
    try { await access(path); executablePath = path; break } catch {}
  }
  browser = await chromium.launch({ executablePath, headless: true })
  const origin = `http://127.0.0.1:${fixture.port}`
  const newPage = async (colorScheme = 'light') => {
    const page = await browser.newPage({ colorScheme, viewport: { width: 1440, height: 960 } })
    page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(15000)
    return page
  }
  const open = async page => { await page.goto(origin); await page.locator('.brand').waitFor(); await page.getByRole('button', { name: '全局设置', exact: true }).waitFor() }
  const images = page => page.locator('.sidebar > .region-background, .workspace-background > .region-background')
  const scene = async (page, name) => {
    await page.waitForFunction(name => {
      const elements = document.querySelectorAll('.sidebar > .region-background, .workspace-background > .region-background')
      return elements.length === 2 && [...elements].every(img => img.src.includes(`/skins/${name}/`) && img.complete && img.naturalWidth > 0)
    }, name)
  }
  const panel = async page => page.getByRole('button', { name: '打开外观设置', exact: true }).click()
  const light = await newPage(); await open(light); await scene(light, 'harbor-dawn')
  assert.equal(await light.title(), '小站 · LittleDock')
  assert.equal(await light.locator('.brand strong').textContent(), '小站')
  assert.equal(await light.locator('.brand-mark').evaluate(image => new URL(image.src).pathname), '/brand/littledock-otter.png')
  assert.equal(await light.locator('link[rel=icon]').evaluate(link => new URL(link.href).pathname), '/brand/littledock-otter-icon.png')
  await light.locator('.brand-mark').evaluate(image => image.decode())
  await light.screenshot({ path: join(screenshots, 'littledock-dawn.png'), fullPage: true, animations: 'disabled' })
  await light.screenshot({ path: join(screenshots, 'littledock-brand-header.png'), clip: { x: 0, y: 0, width: 232, height: 236 }, animations: 'disabled' })
  await panel(light)
  assert.equal(await light.locator('.scenic-skin-option').count(), 3)
  await light.getByRole('button', { name: /暮色归港/ }).click(); await scene(light, 'harbor-dusk')
  await light.keyboard.press('Escape'); await light.screenshot({ path: join(screenshots, 'littledock-dusk.png'), fullPage: true, animations: 'disabled' })
  await light.reload(); await scene(light, 'harbor-dusk')
  await panel(light); await light.getByRole('button', { name: '移除这一侧的背景', exact: true }).click()
  assert.equal(await images(light).count(), 1)
  assert.match(await images(light).first().getAttribute('src'), /harbor-dusk\/sidebar/)
  await light.reload(); assert.equal(await images(light).count(), 1)
  await panel(light)
  await light.getByLabel('选择背景图片或视频', { exact: true }).setInputFiles(resolve('../frontend/public/brand/littledock-mark.png'))
  await light.waitForFunction(() => document.querySelector('.workspace-background img')?.src.startsWith('blob:'))
  await light.reload(); await light.waitForFunction(() => document.querySelector('.workspace-background img')?.src.startsWith('blob:'))
  await panel(light); await light.getByRole('button', { name: /晨雾小港/ }).click(); await scene(light, 'harbor-dawn')
  await light.getByRole('button', { name: /^雾松/ }).click()
  assert.match(await light.locator('.workspace-background img').getAttribute('src'), /^blob:/)
  await light.getByRole('button', { name: '恢复默认外观', exact: true }).click(); await scene(light, 'harbor-dawn')
  await light.getByRole('button', { name: /^雾松/ }).click(); assert.equal(await images(light).count(), 0)
  await light.getByRole('button', { name: '恢复默认外观', exact: true }).click(); await scene(light, 'harbor-dawn')
  // A short real WebM is created in memory; no sample media enters the user's profile or release.
  const createClip = mime => light.evaluate(async mime => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180
    const drawing = canvas.getContext('2d'), stream = canvas.captureStream(12), parts = []
    const recorder = new MediaRecorder(stream, { mimeType: mime })
    recorder.ondataavailable = event => parts.push(event.data)
    let step = 0
    const timer = setInterval(() => { drawing.fillStyle = step++ % 2 ? '#31584b' : '#8fa699'; drawing.fillRect(0, 0, 320, 180) }, 70)
    recorder.start()
    await new Promise(resolve => setTimeout(resolve, 900))
    await new Promise(resolve => { recorder.onstop = resolve; recorder.stop() })
    clearInterval(timer); stream.getTracks().forEach(track => track.stop())
    const bytes = new Uint8Array(await new Blob(parts, { type: mime.split(';')[0] }).arrayBuffer())
    return btoa(String.fromCharCode(...bytes))
  }, mime)
  const clip = await createClip('video/webm;codecs=vp8')
  const upload = { name: 'isolated-background.webm', mimeType: 'video/webm', buffer: Buffer.from(clip, 'base64') }
  await light.getByLabel('选择背景图片或视频', { exact: true }).setInputFiles(upload)
  const playing = async selector => light.waitForFunction(selector => {
    const video = document.querySelector(selector)
    return video instanceof HTMLVideoElement && video.readyState >= 2 && video.muted && video.loop && video.playsInline && !video.paused && video.currentTime > 0
  }, selector)
  await playing('.workspace-background video')
  assert.equal(await light.locator('.image-uploader video').evaluate(el => el.paused), true)
  const previous = await light.locator('.workspace-background video').evaluate(el => el.src)
  await light.getByLabel('选择背景图片或视频', { exact: true }).setInputFiles({ name: 'invalid.webm', mimeType: 'video/webm', buffer: Buffer.from('not a video') })
  await light.getByRole('alert').filter({ hasText: '无法读取此视频' }).waitFor()
  assert.equal(await light.locator('.workspace-background video').getAttribute('src'), previous)
  await light.reload(); await playing('.workspace-background video')
  await light.waitForFunction(() => {
    const video = document.querySelector('.workspace-background video')
    window.__backgroundLoop ??= { last: video.currentTime, count: 0 }
    if (video.currentTime < window.__backgroundLoop.last) window.__backgroundLoop.count++
    window.__backgroundLoop.last = video.currentTime
    return window.__backgroundLoop.count >= 2
  })
  await light.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')) })
  assert.equal(await light.locator('.workspace-background video').evaluate(el => el.paused), true)
  await light.evaluate(() => { delete document.visibilityState; document.dispatchEvent(new Event('visibilitychange')) })
  await playing('.workspace-background video')
  await panel(light); await light.getByRole('button', { name: '左侧导航栏', exact: true }).click()
  await light.getByLabel('选择背景图片或视频', { exact: true }).setInputFiles(upload)
  await playing('.sidebar > video'); assert.equal(await light.locator('.region-background:is(video)').count(), 2)
  await light.getByRole('button', { name: '移除这一侧的背景', exact: true }).click()
  await light.locator('.sidebar > video').waitFor({ state: 'detached' })
  await playing('.workspace-background video')
  await light.getByRole('button', { name: /暮色归港/ }).click(); await scene(light, 'harbor-dusk')
  assert.equal(await light.locator('video').count(), 0)
  await light.getByRole('button', { name: /^雾松/ }).click(); await playing('.workspace-background video')
  await light.getByRole('button', { name: '恢复默认外观', exact: true }).click(); await scene(light, 'harbor-dawn')
  const mp4 = 'video/mp4;codecs=avc1.42001E'
  if (await light.evaluate(mime => MediaRecorder.isTypeSupported(mime), mp4)) {
    await light.getByRole('button', { name: '右侧工作区', exact: true }).click()
    await light.getByLabel('选择背景图片或视频', { exact: true }).setInputFiles({ name: 'isolated-background.mp4', mimeType: 'video/mp4', buffer: Buffer.from(await createClip(mp4), 'base64') })
    await playing('.workspace-background video')
    await light.reload(); await playing('.workspace-background video'); await panel(light)
    await light.getByRole('button', { name: '恢复默认外观', exact: true }).click(); await scene(light, 'harbor-dawn')
    console.log('MP4/H.264 upload, autoplay and reload passed.')
  } else console.log('MP4 encoder unavailable in this test browser; WebM is the validated playback format.')
  await light.getByLabel('界面语言', { exact: true }).selectOption('en')
  assert.equal(await light.locator('.brand strong').textContent(), 'LittleDock')
  assert.equal(await light.getByRole('button', { name: /Harbor Dawn/ }).count(), 1)
  await light.keyboard.press('Escape'); await light.screenshot({ path: join(screenshots, 'littledock-english.png'), fullPage: true, animations: 'disabled' })
  await light.evaluate(() => localStorage.setItem('webnav.workspace-layout', JSON.stringify({ navigationWidth: 164 })))
  await light.reload(); await light.locator('.brand-mark').evaluate(image => image.decode())
  assert.equal(await light.locator('.brand').evaluate(element => {
    const bounds = element.getBoundingClientRect(), sidebar = element.closest('.sidebar').getBoundingClientRect()
    const text = element.querySelector('strong').getBoundingClientRect()
    return bounds.right <= sidebar.right && text.right <= sidebar.right && element.scrollWidth <= element.clientWidth
  }), true)
  await light.screenshot({ path: join(screenshots, 'littledock-narrow-sidebar.png'), fullPage: true, animations: 'disabled' })
  const dark = await newPage('dark'); await open(dark); await scene(dark, 'harbor-dusk')
  assert.equal(await dark.locator('html').getAttribute('data-theme'), 'dark')
  await dark.setViewportSize({ width: 390, height: 844 })
  await dark.locator('.navigation-toggle').click()
  await dark.screenshot({ path: join(screenshots, 'littledock-mobile.png'), fullPage: true, animations: 'disabled' })
  assert.equal(await dark.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await dark.locator('.mobile-close').click()
  await panel(dark)
  assert.equal(await dark.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  for (const preset of [undefined, 'mist-lake', 'solid']) {
    const legacy = await newPage()
    const saved = { skin: preset === 'mist-lake' ? 'mist-lake' : 'sand', accent: '#78604e', left: { color: '#eae5de', preset }, right: { color: '#f3f0eb', preset } }
    await legacy.addInitScript(value => localStorage.setItem('webnav.appearance.v1', JSON.stringify(value)), saved)
    await open(legacy)
    if (preset === 'mist-lake') await scene(legacy, 'mist-lake')
    else assert.equal(await images(legacy).count(), 0)
    assert.deepEqual(await legacy.evaluate(() => JSON.parse(localStorage.getItem('webnav.appearance.v1'))), JSON.parse(JSON.stringify(saved)))
    await legacy.close()
  }
  assert.deepEqual(errors, [])
  console.log('Brand/theme browser acceptance passed: defaults, bilingual branding, legacy preferences, 390px, images and real WebM upload/decode, two loops, silent autoplay, per-side removal, reload, hidden-page pause/resume, theme restoration/reset and invalid-video rollback.')
} finally { await browser?.close(); await fixture.close() }
