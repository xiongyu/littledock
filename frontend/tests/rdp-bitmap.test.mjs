import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

// Exercise the installed dependency patch, including a decode completing after
// its frame was cancelled. No browser, image contents or network is required.
const source = await readFile(fileURLToPath(import.meta.resolve('guacamole-common-js')), 'utf8')
const start = source.indexOf('this.drawBlob = function(')
const end = source.indexOf('\n    };', start)
const install = new Function('window', 'scheduleTask', source.slice(start, end + 7))
function setup() {
  let resolve, task, closed = 0, drawn = 0
  const display = {}
  install.call(display, { createImageBitmap: () => new Promise(done => { resolve = done }) }, handler => {
    task = { cancelled: false, unblocked: false, cancel() { task.cancelled = true }, unblock() { task.unblocked = true }, run() { if (!task.cancelled) handler() } }
    return task
  })
  display.drawBlob({ drawImage() { drawn++ } }, 0, 0, new Blob())
  return { task, resolve: () => resolve({ close() { closed++ } }), counts: () => ({ closed, drawn }) }
}
test('RDP decoded bitmaps release after draw and after cancellation, including late decode', async () => {
  const rendered = setup(); rendered.resolve(); await Promise.resolve()
  assert.equal(rendered.task.unblocked, true); rendered.task.run()
  assert.deepEqual(rendered.counts(), { closed: 1, drawn: 1 })
  rendered.task.cancel(); assert.equal(rendered.counts().closed, 1)
  const queued = setup(); queued.resolve(); await Promise.resolve(); queued.task.cancel(); queued.task.run()
  assert.deepEqual(queued.counts(), { closed: 1, drawn: 0 })
  const late = setup(); late.task.cancel(); late.resolve(); await Promise.resolve(); late.task.run()
  assert.deepEqual(late.counts(), { closed: 1, drawn: 0 })
})
