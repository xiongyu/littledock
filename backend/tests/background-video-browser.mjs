// Exercise the saved scenic MP4 through the real upload UI in an isolated profile.
import assert from 'node:assert/strict'
import { access, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { platformFixture } from './plugin-platform-fixture.mjs'

const input = resolve('../docs/design/videos/harbor-dusk-loop.mp4')
await access(input)
const fixture = await platformFixture()
let browser
try {
  let executablePath
  for (const path of ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe']) {
    try { await access(path); executablePath = path; break } catch {}
  }
  browser = await chromium.launch({ executablePath, headless: true })
  const page = await browser.newPage({ colorScheme: 'dark', viewport: { width: 1440, height: 960 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(15000)
  await page.goto(`http://127.0.0.1:${fixture.port}`)
  const panel = () => page.getByRole('button', { name: '打开外观设置', exact: true }).click()
  await panel()
  await page.getByLabel('选择背景图片或视频', { exact: true }).setInputFiles(input)
  const playing = () => page.waitForFunction(() => {
    const video = document.querySelector('.workspace-background video')
    return video && video.readyState >= 2 && !video.paused && video.currentTime > 0 && video.muted && video.loop && video.playsInline
  })
  await playing(); await page.keyboard.press('Escape')
  const loops = await page.evaluate(() => new Promise((resolve, reject) => {
    const video = document.querySelector('.workspace-background video')
    let last = video.currentTime, count = 0, frames = 0, callback
    const timer = setTimeout(() => { video.cancelVideoFrameCallback(callback); reject(new Error('Two loop boundaries not reached')) }, 26000)
    const frame = (_now, metadata) => {
      frames++
      if (metadata.mediaTime + 0.2 < last) count++
      last = metadata.mediaTime
      if (count >= 2) { clearTimeout(timer); resolve({ count, decodedFrameCallbacks: frames, duration: video.duration, width: video.videoWidth, height: video.videoHeight }); return }
      callback = video.requestVideoFrameCallback(frame)
    }
    callback = video.requestVideoFrameCallback(frame)
  }))
  const motion = await page.locator('.workspace-background video').evaluate(async video => {
    video.pause()
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    const read = async time => {
      const sought = new Promise(resolve => video.addEventListener('seeked', resolve, { once: true }))
      video.currentTime = time; await sought
      ctx.drawImage(video, 0, 0, 320, 180)
      return ctx.getImageData(0, 100, 260, 80).data
    }
    const first = await read(0), middle = await read(2), last = await read(8 - 1 / 24)
    const difference = (a, b) => {
      let sum = 0
      for (let i = 0; i < a.length; i++) if (i % 4 !== 3) sum += Math.abs(a[i] - b[i])
      return sum / (a.length * 0.75)
    }
    await video.play()
    return { waterMotionMeanDifference: difference(first, middle), loopSeamMeanDifference: difference(first, last) }
  })
  assert.ok(motion.waterMotionMeanDifference > 0.1, 'The decoded video must contain actual visible motion')
  assert.ok(motion.loopSeamMeanDifference < 3, 'The loop must not jump to a substantially different frame')
  await page.reload(); await playing()
  assert.equal(await page.locator('.sidebar > img').count(), 1)
  await page.screenshot({ path: resolve('../docs/design/screenshots/littledock-video.png'), fullPage: true, animations: 'disabled' })
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')) })
  assert.equal(await page.locator('.workspace-background video').evaluate(video => video.paused), true)
  await page.evaluate(() => { delete document.visibilityState; document.dispatchEvent(new Event('visibilitychange')) }); await playing()
  await panel(); await page.getByRole('button', { name: '左侧导航栏', exact: true }).click()
  await page.getByLabel('选择背景图片或视频', { exact: true }).setInputFiles(input)
  await page.waitForFunction(() => { const video = document.querySelector('.sidebar > video'); return video && !video.paused && video.currentTime > 0 })
  await page.getByRole('button', { name: '移除这一侧的背景', exact: true }).click()
  await page.locator('.sidebar > video').waitFor({ state: 'detached' }); await playing()
  assert.deepEqual(errors, [])
  const result = { asset: 'harbor-dusk-loop.mp4', bytes: (await stat(input)).size, browser: browser.version(), ...loops, ...motion,
    silentAutoplay: true, reloadRestoresVideo: true, simulatedVisibilityPauseResume: true, independentLeftAndRight: true, pageErrors: errors }
  await writeFile(resolve('../docs/design/videos/harbor-dusk-validation.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result))
} finally { await browser?.close(); await fixture.close() }
