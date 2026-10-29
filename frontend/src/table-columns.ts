import type { Directive } from 'vue'

interface ColumnOptions { id: string; widths: readonly number[]; minimums?: readonly number[]; fill?: number }
const maximum = 1600
const storageKey = (id: string) => `webnav.table-columns.v1.${id}`
type TableState = ReturnType<typeof createColumns>
const tables = new WeakMap<HTMLTableElement, TableState>()

function createColumns(table: HTMLTableElement, options: ColumnOptions) {
  const headers = [...(table.tHead?.rows[0]?.cells ?? [])]
  const minimums = headers.map((_, i) => options.minimums?.[i] ?? 56)
  const clamp = (width: number, i: number) => Math.round(Math.min(maximum, Math.max(minimums[i]!, width)))
  const defaults = headers.map((_, i) => clamp(options.widths[i] ?? 160, i))
  let widths = [...defaults], customized = false, disposed = false
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(storageKey(options.id)) ?? 'null')
    if (Array.isArray(saved) && saved.length === headers.length && saved.every(width => typeof width === 'number' && Number.isFinite(width) && width >= 32 && width <= maximum)) { widths = saved.map(clamp); customized = true }
  } catch { /* A blocked or stale appearance store must not prevent reading the table. */ }
  const group = document.createElement('colgroup'), grips: HTMLSpanElement[] = [], releases: (() => void)[] = []
  group.dataset.columnWidths = options.id
  for (const _ of headers) group.append(document.createElement('col'))
  table.prepend(group); table.dataset.resizableColumns = options.id
  let drag: { index: number; x: number; original: number[]; customized: boolean; pointer: number; grip: HTMLSpanElement } | undefined
  function apply() {
    if (disposed) return
    table.style.width = widths.reduce((sum, value) => sum + value, 0) + 'px'
    for (const [index, column] of [...group.children].entries()) (column as HTMLElement).style.width = widths[index] + 'px'
    grips.forEach((grip, i) => grip.setAttribute('aria-valuenow', String(widths[i])))
  }
  function persist() { customized = true; try { localStorage.setItem(storageKey(options.id), JSON.stringify(widths)) } catch { /* Session widths remain usable. */ } }
  function fit() {
    if (disposed || customized || drag) return
    widths = [...defaults]
    const fill = options.fill
    if (fill !== undefined && fill >= 0 && fill < widths.length) widths[fill] = clamp(widths[fill]! + Math.max(0, (table.parentElement?.clientWidth ?? 0) - widths.reduce((sum, value) => sum + value, 0)), fill)
    apply()
  }
  function finish(cancel = false) {
    if (!drag) return
    const old = drag; drag = undefined
    if (cancel) { widths = old.original; customized = old.customized; apply() } else persist()
    delete table.dataset.columnResizing
    if (old.grip.hasPointerCapture(old.pointer)) old.grip.releasePointerCapture(old.pointer)
  }
  headers.forEach((header, index) => {
    const grip = document.createElement('span'), label = header.textContent?.trim().replace(/[↑↓]/g, '').trim() || `第 ${index + 1}`
    grip.className = 'table-column-grip'; grip.tabIndex = 0; grip.setAttribute('role', 'separator'); grip.setAttribute('aria-orientation', 'vertical')
    grip.setAttribute('aria-label', `调整${label}列宽`); grip.setAttribute('aria-valuemin', String(minimums[index])); grip.setAttribute('aria-valuemax', String(maximum))
    grip.title = '拖动调宽 · 双击恢复此列 · 方向键微调'
    const down = (event: PointerEvent) => {
      if (event.button !== 0 || drag) return
      event.preventDefault(); event.stopPropagation(); grip.focus({ preventScroll: true })
      drag = { index, x: event.clientX, original: [...widths], customized, pointer: event.pointerId, grip }
      table.dataset.columnResizing = String(index); grip.setPointerCapture(event.pointerId)
    }
    const move = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointer) return
      widths[index] = clamp(drag.original[index]! + event.clientX - drag.x, index); apply()
    }
    const up = (event: PointerEvent) => { if (event.pointerId === drag?.pointer) finish() }
    const cancel = () => finish(true)
    const reset = (event: MouseEvent) => { event.preventDefault(); event.stopPropagation(); finish(true); widths[index] = defaults[index]!; apply(); persist() }
    const click = (event: MouseEvent) => { event.preventDefault(); event.stopPropagation() }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { finish(true); return }
      if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return
      event.preventDefault(); event.stopPropagation()
      widths[index] = event.key === 'Home' ? defaults[index]! : clamp(widths[index]! + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 24 : 8), index)
      apply(); persist()
    }
    grip.addEventListener('pointerdown', down); grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', cancel); grip.addEventListener('lostpointercapture', cancel)
    grip.addEventListener('dblclick', reset); grip.addEventListener('click', click); grip.addEventListener('keydown', key)
    releases.push(() => { grip.removeEventListener('pointerdown', down); grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', cancel); grip.removeEventListener('lostpointercapture', cancel); grip.removeEventListener('dblclick', reset); grip.removeEventListener('click', click); grip.removeEventListener('keydown', key); grip.remove() })
    header.append(grip); grips.push(grip)
  })
  const observer = new ResizeObserver(fit)
  if (table.parentElement) observer.observe(table.parentElement)
  fit(); apply()
  return {
    id: options.id,
    refresh() { if (!table.contains(group)) table.prepend(group); headers.forEach((header, i) => { if (!header.contains(grips[i]!)) header.append(grips[i]!) }); apply() },
    dispose() { finish(true); disposed = true; observer.disconnect(); for (const release of releases) release(); group.remove(); delete table.dataset.resizableColumns; table.style.removeProperty('width') },
  }
}

/** Sizes are appearance-only, never process names, IDs, paths or snapshots. */
export const vResizableColumns: Directive<HTMLTableElement, ColumnOptions> = {
  mounted(table, binding) { tables.set(table, createColumns(table, binding.value)) },
  updated(table, binding) {
    const state = tables.get(table)
    if (state?.id === binding.value.id) state.refresh()
    else { state?.dispose(); tables.set(table, createColumns(table, binding.value)) }
  },
  beforeUnmount(table) { tables.get(table)?.dispose(); tables.delete(table) },
}
