/** A native dialog retargets clicks from its ::backdrop to the dialog itself. */
export function createBackdropGuard(onClick: () => void) {
  let press: { id: number; x: number; y: number } | undefined
  let released = false
  function reset() { press = undefined; released = false }
  function outside(event: MouseEvent) {
    const dialog = event.currentTarget as HTMLDialogElement
    const bounds = dialog.getBoundingClientRect()
    return event.target === dialog && (
      event.clientX < bounds.left || event.clientX >= bounds.right ||
      event.clientY < bounds.top || event.clientY >= bounds.bottom
    )
  }
  function pointerdown(event: PointerEvent) {
    reset()
    if (event.isPrimary && event.button === 0 && outside(event)) {
      press = { id: event.pointerId, x: event.clientX, y: event.clientY }
    }
  }
  function pointermove(event: PointerEvent) {
    if (press && (event.pointerId !== press.id || Math.hypot(event.clientX - press.x, event.clientY - press.y) > 6)) reset()
  }
  function pointerup(event: PointerEvent) {
    pointermove(event)
    released = !!press && event.pointerId === press.id && event.button === 0 && outside(event)
    if (!released) reset()
  }
  function click(event: MouseEvent) {
    const intentionalClick = released && event.button === 0 && outside(event)
    reset()
    if (intentionalClick) onClick()
  }
  return { pointerdown, pointermove, pointerup, pointercancel: reset, click }
}
