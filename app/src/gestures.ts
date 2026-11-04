// Pointer gestures for the field: one handler set for mouse, trackpad, and touch.
// Tap, double tap, drag to pan, two-finger pinch, wheel and trackpad-pinch zoom.

export type GestureHandlers = {
  onTap: (x: number, y: number) => void
  onDoubleTap: (x: number, y: number) => void
  onPan: (dx: number, dy: number) => void
  onZoom: (x: number, y: number, factor: number) => void
}

const TAP_SLOP = 6 // px a press may wander and still count as a tap
const TAP_MS = 450
const DOUBLE_MS = 300

export function attachGestures(el: HTMLElement, h: GestureHandlers): () => void {
  const pts = new Map<number, { x: number; y: number }>()
  let moved = false
  let downAt = 0
  let start = { x: 0, y: 0 }
  let lastTap = { t: 0, x: 0, y: 0 }
  let pinch = { d: 0, x: 0, y: 0 }

  const local = (e: PointerEvent | WheelEvent) => {
    const r = el.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  const pair = () => {
    const [a, b] = [...pts.values()]
    return { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  }

  const down = (e: PointerEvent) => {
    try {
      el.setPointerCapture(e.pointerId)
    } catch {
      // some browsers refuse capture for pointers they no longer track; gestures still work
    }
    const p = local(e)
    pts.set(e.pointerId, p)
    if (pts.size === 1) {
      moved = false
      downAt = performance.now()
      start = p
    } else if (pts.size === 2) {
      moved = true // a second finger is never a tap
      pinch = pair()
    }
  }

  const move = (e: PointerEvent) => {
    const prev = pts.get(e.pointerId)
    if (!prev) return
    const p = local(e)
    pts.set(e.pointerId, p)
    if (pts.size === 1) {
      if (!moved && Math.hypot(p.x - start.x, p.y - start.y) > TAP_SLOP) moved = true
      if (moved) h.onPan(p.x - prev.x, p.y - prev.y)
    } else if (pts.size === 2) {
      const now = pair()
      if (pinch.d > 0) {
        h.onZoom(now.x, now.y, now.d / pinch.d)
        h.onPan(now.x - pinch.x, now.y - pinch.y)
      }
      pinch = now
    }
  }

  const up = (e: PointerEvent, cancelled = false) => {
    if (!pts.has(e.pointerId)) return
    pts.delete(e.pointerId)
    if (pts.size < 2) pinch = { d: 0, x: 0, y: 0 }
    if (cancelled || pts.size > 0 || moved || performance.now() - downAt > TAP_MS) return
    const p = local(e)
    const now = performance.now()
    if (now - lastTap.t < DOUBLE_MS && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 24) {
      lastTap = { t: 0, x: 0, y: 0 }
      h.onDoubleTap(p.x, p.y)
    } else {
      lastTap = { t: now, ...p }
      h.onTap(p.x, p.y)
    }
  }

  const wheel = (e: WheelEvent) => {
    e.preventDefault()
    const p = local(e)
    // Trackpad pinch arrives as a wheel event with ctrlKey set; it needs more gain.
    const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015))
    h.onZoom(p.x, p.y, factor)
  }

  const onUp = (e: PointerEvent) => up(e)
  const onCancel = (e: PointerEvent) => up(e, true)
  el.style.touchAction = 'none'
  el.addEventListener('pointerdown', down)
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', onUp)
  el.addEventListener('pointercancel', onCancel)
  el.addEventListener('wheel', wheel, { passive: false })
  return () => {
    el.removeEventListener('pointerdown', down)
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', onUp)
    el.removeEventListener('pointercancel', onCancel)
    el.removeEventListener('wheel', wheel)
  }
}
