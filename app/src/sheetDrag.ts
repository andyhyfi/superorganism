// Drag the bottom sheet's grabber; it snaps to peek, half, or full on release.
import type { Sheet } from './Deep'

const SNAP: Sheet[] = ['peek', 'half', 'full']

export function attachSheetDrag(
  handle: HTMLElement,
  sheet: HTMLElement,
  current: () => Sheet,
  set: (s: Sheet) => void,
): () => void {
  let startY = 0
  let startH = 0
  let lastY = 0
  let lastT = 0
  let v = 0
  let dragging = false
  let moved = false

  const heights = () => {
    const vh = window.innerHeight
    return { peek: vh * 0.22, half: vh * 0.52, full: vh - 56 }
  }

  const down = (e: PointerEvent) => {
    dragging = true
    moved = false
    startY = lastY = e.clientY
    lastT = performance.now()
    startH = sheet.getBoundingClientRect().height
    v = 0
    try { handle.setPointerCapture(e.pointerId) } catch { /* ignore */ }
  }
  const move = (e: PointerEvent) => {
    if (!dragging) return
    const dy = e.clientY - startY
    if (Math.abs(dy) > 4) moved = true
    if (!moved) return
    const now = performance.now()
    v = (e.clientY - lastY) / Math.max(1, now - lastT) // px per ms, + is downward
    lastY = e.clientY
    lastT = now
    const h = heights()
    sheet.style.transition = 'none'
    sheet.style.height = `${Math.max(h.peek * 0.6, Math.min(h.full, startH - dy))}px`
  }
  const up = () => {
    if (!dragging) return
    dragging = false
    sheet.style.transition = ''
    const cur = current()
    if (!moved) {
      // a tap on the grabber steps through the sizes
      set(cur === 'peek' ? 'half' : cur === 'half' ? 'full' : 'half')
      sheet.style.height = ''
      return
    }
    const h = heights()
    const now = sheet.getBoundingClientRect().height
    let target: Sheet
    if (Math.abs(v) > 0.5) {
      // a flick moves one step in its direction
      const i = SNAP.indexOf(cur)
      target = SNAP[Math.max(0, Math.min(2, i + (v > 0 ? -1 : 1)))]
    } else {
      target = SNAP.reduce((a, b) => (Math.abs(h[b] - now) < Math.abs(h[a] - now) ? b : a))
    }
    sheet.style.height = ''
    set(target)
  }

  handle.addEventListener('pointerdown', down)
  handle.addEventListener('pointermove', move)
  handle.addEventListener('pointerup', up)
  handle.addEventListener('pointercancel', up)
  return () => {
    handle.removeEventListener('pointerdown', down)
    handle.removeEventListener('pointermove', move)
    handle.removeEventListener('pointerup', up)
    handle.removeEventListener('pointercancel', up)
  }
}
