// The glow field: Canvas 2D renderer for the network. Ported from the approved look test
// (private/sketches/look-test.html, look A). Chain state drives it; it never invents nodes.
import type { Address } from 'viem'
import type { ChainNode, NetEvent } from './chain'

const TAU = Math.PI * 2
const rand = (a: number, b: number) => a + Math.random() * (b - a)
const ease = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2)
const SPLIT_SECONDS = 3.4
const ZMIN = 0.15
const ZMAX = 6
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
const MAX_BUBBLES = 60

type Bubble = { a: number; d: number; amount: number; mine: boolean; w: number; in: number; out: boolean; user: string }

type VNode = {
  id: number
  x: number; y: number; vx: number; vy: number
  r: number
  total: number // USDC
  mid: number // roll-curve midpoint, USDC
  hue: number
  phase: number; spin: number
  bubbles: Bubble[]
  alpha: number
  splitting: null | { ang: number; p: number; c0: number; c1: number }
}

export type Pick = { id: number; total: number } | null

export class Field {
  private ctx: CanvasRenderingContext2D
  private W = 0
  private H = 0
  private t = 0
  private nodes = new Map<number, VNode>()
  private dust = Array.from({ length: 170 }, () => ({ x: Math.random(), y: Math.random(), z: rand(0.2, 1), tw: rand(0, TAU) }))
  private cam = { x: 0, y: 0, z: 1 }
  // Camera: 'auto' frames the whole network; 'manual' holds where the user put it; 'follow'
  // keeps one node centered. In Aquarium, manual eases back to auto after `autoReturnMs` idle.
  private camMode: 'auto' | 'manual' | 'follow' = 'auto'
  private follow: number | null = null
  private lastInput = 0
  private autoReturnMs: number | null = 15000
  private inset = { right: 0, bottom: 0 }
  private zoomTarget: number | null = null
  private raf = 0
  private last = 0
  private you: string
  selected: number | null = null
  onFrame: (() => void) | null = null

  constructor(private canvas: HTMLCanvasElement, you: Address) {
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D is not available')
    this.ctx = ctx
    this.you = you.toLowerCase()
    this.resize()
  }

  // ------------------------------------------------------------ lifecycle

  start() {
    this.last = performance.now()
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - this.last) / 1000)
      this.last = now
      this.t += dt
      this.step(dt)
      this.render()
      this.onFrame?.()
      this.raf = requestAnimationFrame(frame)
    }
    this.raf = requestAnimationFrame(frame)
  }

  stop() {
    cancelAnimationFrame(this.raf)
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    this.W = this.canvas.clientWidth
    this.H = this.canvas.clientHeight
    this.canvas.width = Math.round(this.W * dpr)
    this.canvas.height = Math.round(this.H * dpr)
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  // ----------------------------------------------------------- chain sync

  /** Reconciles visible nodes with chain truth. Live nodes appear; totals and traits update. */
  sync(chain: ChainNode[]) {
    for (const c of chain) {
      const v = this.nodes.get(c.id)
      const total = Number(c.total) / 1e6
      const mid = Number(c.traits.rollMidFill) / 1e6
      if (c.split) {
        // A split node lives on screen only while its division animates.
        if (v && !v.splitting) {
          this.nodes.delete(c.id)
          if (this.selected === c.id) this.selected = null
        }
        continue
      }
      if (v) {
        v.total = total
        v.mid = mid
      } else if (!this.isPendingChild(c.id)) {
        this.nodes.set(c.id, this.makeNode(c, chain, total, mid))
      }
    }
  }

  /** Feeds contract events. `instant` skips animation (used when loading history). */
  apply(events: NetEvent[], instant = false) {
    for (const e of events) {
      if (e.kind === 'deposit') {
        const n = this.nodes.get(e.node)
        if (!n) continue
        const amount = Number(e.amount) / 1e6
        n.bubbles.push(this.makeBubble(amount, e.user, instant))
        if (!instant) n.total += amount
        this.trim(n)
      } else if (e.kind === 'withdraw') {
        const n = this.nodes.get(e.node)
        if (!n) continue
        let left = Number(e.amount) / 1e6
        const u = e.user.toLowerCase()
        for (let i = n.bubbles.length - 1; i >= 0 && left > 0; i--) {
          const b = n.bubbles[i]
          if (b.user !== u || b.out) continue
          left -= b.amount
          if (instant) n.bubbles.splice(i, 1)
          else b.out = true
        }
      } else if (e.kind === 'split') {
        const n = this.nodes.get(e.parent)
        if (!n) continue
        if (instant) this.finishSplit(n, rand(0, TAU), e.c0, e.c1)
        else if (!n.splitting) n.splitting = { ang: rand(0, TAU), p: 0, c0: e.c0, c1: e.c1 }
      }
    }
  }

  // --------------------------------------------------------------- picking

  pick(px: number, py: number): Pick {
    const [x, y] = this.toWorld(px, py)
    let best: VNode | null = null
    for (const n of this.nodes.values()) {
      if (n.splitting) continue
      const d = Math.hypot(n.x - x, n.y - y)
      if (d <= n.r * 1.15 && (!best || n.r < best.r)) best = n
    }
    return best ? { id: best.id, total: best.total } : null
  }

  /** Screen position and radius of a node, for anchoring UI. */
  screenOf(id: number): { x: number; y: number; r: number } | null {
    const n = this.nodes.get(id)
    if (!n) return null
    const [x, y] = this.toScreen(n.x, n.y)
    return { x, y, r: n.r * this.cam.z }
  }

  liveCount() {
    let k = 0
    for (const n of this.nodes.values()) if (!n.splitting) k++
    return k
  }

  // ------------------------------------------------------------- internals

  private isPendingChild(id: number) {
    for (const n of this.nodes.values()) if (n.splitting && (n.splitting.c0 === id || n.splitting.c1 === id)) return true
    return false
  }

  private makeNode(c: ChainNode, chain: ChainNode[], total: number, mid: number): VNode {
    const parent = chain[c.parent]
    const pv = c.id === 0 ? null : this.nodes.get(c.parent)
    const hue = this.hueOf(c, chain)
    return {
      id: c.id,
      x: pv ? pv.x + rand(-20, 20) : 0,
      y: pv ? pv.y + rand(-20, 20) : 0,
      vx: 0, vy: 0,
      r: radiusOf(total),
      total, mid, hue,
      phase: rand(0, TAU),
      spin: (Math.random() < 0.5 ? -1 : 1) * rand(0.6, 1.2),
      bubbles: [],
      alpha: c.id === 0 || !parent ? 1 : 0,
      splitting: null,
    }
  }

  /** Lineage tint: the root is blue; each generation drifts a little, left child one way, right the other. */
  private hueOf(c: ChainNode, chain: ChainNode[]): number {
    let hue = 214
    let n = c
    const path: number[] = []
    while (n.id !== 0) {
      path.push(n.id)
      n = chain[n.parent]
    }
    for (const id of path.reverse()) hue += id % 2 ? 9 : -9
    return hue
  }

  private makeBubble(amount: number, user: string, instant: boolean): Bubble {
    return {
      a: rand(0, TAU), d: rand(0.15, 0.8), amount,
      mine: user.toLowerCase() === this.you, user: user.toLowerCase(),
      w: rand(0.08, 0.25) * (Math.random() < 0.5 ? -1 : 1),
      in: instant ? 1 : 0, out: false,
    }
  }

  private trim(n: VNode) {
    // Visual cap only. Keep every one of your bubbles; drop the oldest of everyone else's.
    while (n.bubbles.length > MAX_BUBBLES) {
      const i = n.bubbles.findIndex(b => !b.mine)
      if (i < 0) break
      n.bubbles.splice(i, 1)
    }
  }

  private finishSplit(n: VNode, ang: number, c0: number, c1: number) {
    const ux = Math.cos(ang), uy = Math.sin(ang)
    const rc = n.r * Math.SQRT1_2
    const off = rc * 1.14
    const kids: VNode[] = [c0, c1].map((id, i) => {
      const s = i ? -1 : 1
      return {
        id,
        x: n.x + ux * off * s, y: n.y + uy * off * s,
        vx: ux * 0.35 * s, vy: uy * 0.35 * s,
        r: rc, total: n.total / 2, mid: n.mid,
        hue: n.hue + (id % 2 ? 9 : -9),
        phase: n.phase, spin: n.spin,
        // every claim halves into each child, so both children carry every depositor
        bubbles: n.bubbles.filter(b => !b.out).map(b => ({ ...b, amount: b.amount / 2, a: b.a + i * 1.3, in: 1 })),
        alpha: 1, splitting: null,
      }
    })
    this.nodes.delete(n.id)
    for (const k of kids) this.nodes.set(k.id, k)
    if (this.selected === n.id) this.selected = null
    if (this.follow === n.id) this.follow = c0 // keep following the line: first child
  }

  private step(dt: number) {
    const f60 = dt * 60
    for (const n of this.nodes.values()) {
      if (!n.splitting) n.r += (radiusOf(n.total) - n.r) * Math.min(1, dt * 1.5)
      n.alpha += (1 - n.alpha) * Math.min(1, dt * 1.2)
      n.vx += (-n.x * 0.00002 + Math.sin(this.t * 0.11 + n.phase) * 0.0016) * f60
      n.vy += (-n.y * 0.00003 + Math.cos(this.t * 0.09 + n.phase) * 0.0016) * f60
    }
    const list = [...this.nodes.values()]
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j]
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 0.01
      const min = (a.r + b.r) * 1.35 + 18
      if (d < min) {
        const f = ((min - d) / min) * 0.02 * f60, ux = dx / d, uy = dy / d
        a.vx -= ux * f; a.vy -= uy * f; b.vx += ux * f; b.vy += uy * f
      }
    }
    for (const n of list) {
      const damp = Math.pow(0.985, f60)
      n.vx *= damp; n.vy *= damp
      n.x += n.vx * f60; n.y += n.vy * f60
      for (const b of n.bubbles) {
        b.a += b.w * dt * n.spin * 0.5
        b.in = b.out ? Math.max(0, b.in - dt * 0.9) : Math.min(1, b.in + dt * 0.7)
      }
      n.bubbles = n.bubbles.filter(b => !(b.out && b.in <= 0))
      if (n.splitting) {
        n.splitting.p += dt / SPLIT_SECONDS
        if (n.splitting.p >= 1) this.finishSplit(n, n.splitting.ang, n.splitting.c0, n.splitting.c1)
      }
    }
    this.updateCamera(dt)
  }

  private updateCamera(dt: number) {
    if (!this.nodes.size) return
    const vw = this.W - this.inset.right, vh = this.H - this.inset.bottom
    if (this.camMode === 'manual' && this.autoReturnMs != null && performance.now() - this.lastInput > this.autoReturnMs) {
      this.camMode = 'auto'
    }
    if (this.camMode === 'follow') {
      const n = this.follow != null ? this.nodes.get(this.follow) : undefined
      if (!n) {
        // followed node split or left: frame its children if they exist, else everything
        this.camMode = 'auto'
        this.follow = null
      } else {
        const k = Math.min(1, dt * 2.2)
        const z = this.zoomTarget ?? Math.min(4, Math.min(vw, vh) * 0.32 / Math.max(n.r, 1))
        this.cam.x += (n.x - this.cam.x) * k
        this.cam.y += (n.y - this.cam.y) * k
        this.cam.z += (z - this.cam.z) * k
        return
      }
    }
    if (this.camMode !== 'auto') return
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const n of this.nodes.values()) {
      const pad = n.r * 1.6
      x0 = Math.min(x0, n.x - pad); y0 = Math.min(y0, n.y - pad)
      x1 = Math.max(x1, n.x + pad); y1 = Math.max(y1, n.y + pad)
    }
    const margin = 0.82
    const z = Math.min(1.6, (vw * margin) / (x1 - x0), (vh * margin) / (y1 - y0))
    const k = Math.min(1, dt * 0.6) // slow, aquarium-paced camera
    this.cam.x += ((x0 + x1) / 2 - this.cam.x) * k
    this.cam.y += ((y0 + y1) / 2 - this.cam.y) * k
    this.cam.z += (z - this.cam.z) * k
  }

  // ------------------------------------------------------------- controls

  /** Drag: move the view by screen pixels. */
  pan(dx: number, dy: number) {
    this.takeManual()
    this.cam.x -= dx / this.cam.z
    this.cam.y -= dy / this.cam.z
  }

  /** Zoom by `factor` around a screen point, keeping that point fixed. */
  zoomAt(px: number, py: number, factor: number) {
    if (this.camMode === 'follow') {
      this.zoomTarget = clamp((this.zoomTarget ?? this.cam.z) * factor, ZMIN, ZMAX)
      this.lastInput = performance.now()
      return
    }
    this.takeManual()
    const [wx, wy] = this.toWorld(px, py)
    this.cam.z = clamp(this.cam.z * factor, ZMIN, ZMAX)
    const [nx, ny] = this.toWorld(px, py)
    this.cam.x += wx - nx
    this.cam.y += wy - ny
  }

  /** Zoom by `factor` around the center of the visible area. */
  zoomBy(factor: number) {
    const cx = (this.W - this.inset.right) / 2, cy = (this.H - this.inset.bottom) / 2
    this.zoomAt(cx, cy, factor)
  }

  /** Center and follow a node until the user moves the camera. */
  focus(id: number) {
    if (!this.nodes.has(id)) return
    this.camMode = 'follow'
    this.follow = id
    this.zoomTarget = null
    this.lastInput = performance.now()
  }

  /** Frame the whole network again. */
  fitAll() {
    this.camMode = 'auto'
    this.follow = null
    this.zoomTarget = null
  }

  /** Screen area covered by panels; the camera centers in what is left. */
  setInset(right: number, bottom: number) {
    this.inset = { right, bottom }
  }

  /** How long manual camera control holds before easing back to the whole network. null holds forever. */
  setAutoReturn(ms: number | null) {
    this.autoReturnMs = ms
  }

  cameraMode() {
    return this.camMode
  }

  zoom() {
    return this.cam.z
  }

  private takeManual() {
    if (this.camMode !== 'manual') {
      this.camMode = 'manual'
      this.follow = null
      this.zoomTarget = null
    }
    this.lastInput = performance.now()
  }

  private toScreen(x: number, y: number): [number, number] {
    const cx = (this.W - this.inset.right) / 2, cy = (this.H - this.inset.bottom) / 2
    return [(x - this.cam.x) * this.cam.z + cx, (y - this.cam.y) * this.cam.z + cy]
  }

  private toWorld(px: number, py: number): [number, number] {
    const cx = (this.W - this.inset.right) / 2, cy = (this.H - this.inset.bottom) / 2
    return [(px - cx) / this.cam.z + this.cam.x, (py - cy) / this.cam.z + this.cam.y]
  }

  // ---------------------------------------------------------------- render

  private shapeFn: null | ((a: number) => number) = null
  private shapeR0 = 1

  private wob(n: VNode, ang: number, k: number) {
    const t = this.t
    return 1 + 0.018 * Math.sin(ang * 3 + t * 0.7 + n.phase) * k + 0.012 * Math.sin(ang * 5 - t * 0.5 + n.phase * 2) * k
  }

  private membranePath(n: VNode, x: number, y: number, r: number, k = 1) {
    const ctx = this.ctx
    ctx.beginPath()
    for (let i = 0; i <= 120; i++) {
      const a = (i / 120) * TAU
      const rr = (this.shapeFn ? this.shapeFn(a) * (r / this.shapeR0) : r) * this.wob(n, a, k)
      const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr
      if (i) ctx.lineTo(px, py)
      else ctx.moveTo(px, py)
    }
    ctx.closePath()
  }

  private background() {
    const { ctx, W, H, t } = this
    const g = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.75)
    g.addColorStop(0, '#080c22'); g.addColorStop(0.6, '#04060f'); g.addColorStop(1, '#000001')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, W, H)
    for (const d of this.dust) {
      const x = (((d.x * W + t * 3 * d.z) % W) + W) % W
      const y = (((d.y * H + t * 1.2 * d.z) % H) + H) % H
      const a = (0.15 + 0.25 * (0.5 + 0.5 * Math.sin(t * 0.8 + d.tw))) * d.z
      ctx.fillStyle = `rgba(170,200,255,${a})`
      ctx.fillRect(x, y, d.z * 1.3, d.z * 1.3)
    }
  }

  private drawNode(n: VNode, x: number, y: number, r: number, alpha: number, selected: boolean) {
    if (alpha <= 0.01 || r < 0.5) return
    const { ctx } = this
    const f = fillOf(n.total, n.mid), h = n.hue
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    let g = ctx.createRadialGradient(x, y, r * 0.7, x, y, r * 2.1)
    g.addColorStop(0, `hsla(${h},90%,62%,${0.22 * alpha})`); g.addColorStop(1, `hsla(${h},90%,50%,0)`)
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * 2.1, 0, TAU); ctx.fill()
    g = ctx.createRadialGradient(x - r * 0.25, y - r * 0.3, r * 0.05, x, y, r)
    g.addColorStop(0, `hsla(${h - 10},85%,78%,${0.42 * alpha})`)
    g.addColorStop(0.6, `hsla(${h},80%,46%,${0.24 * alpha})`)
    g.addColorStop(1, `hsla(${h + 12},85%,40%,${0.34 * alpha})`)
    this.membranePath(n, x, y, r); ctx.fillStyle = g; ctx.fill()
    ctx.save(); this.membranePath(n, x, y, r * 0.97); ctx.clip()
    const arms = 3, turns = 0.5 + f * 3.2
    ctx.lineWidth = 0.7; ctx.strokeStyle = `hsla(${h - 20},90%,82%,${(0.1 + f * 0.22) * alpha})`
    for (let k = 0; k < arms; k++) {
      ctx.beginPath()
      for (let i = 0; i <= 70; i++) {
        const s = i / 70, rr = r * 0.92 * Math.pow(s, 0.8)
        const a = (k / arms) * TAU + s * turns * TAU + this.t * 0.12 * n.spin + n.phase
        if (i) ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr)
        else ctx.moveTo(x, y)
      }
      ctx.stroke()
    }
    const scale = Math.max(0.6, Math.min(1.6, this.cam.z))
    for (const b of n.bubbles) {
      const bx = x + Math.cos(b.a) * b.d * r * 0.85, by = y + Math.sin(b.a) * b.d * r * 0.85
      const s = (1.2 + Math.sqrt(b.amount) * 0.32) * b.in * scale
      const c = b.mine ? `hsla(42,100%,70%,${0.95 * alpha * b.in})` : `hsla(${h - 25},100%,88%,${0.8 * alpha * b.in})`
      const bg = ctx.createRadialGradient(bx, by, 0, bx, by, s * 2.2)
      bg.addColorStop(0, c); bg.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = bg; ctx.beginPath(); ctx.arc(bx, by, s * 2.2, 0, TAU); ctx.fill()
    }
    ctx.restore()
    this.membranePath(n, x, y, r); ctx.lineWidth = selected ? 1.8 : 1.2
    ctx.strokeStyle = `hsla(${h - 15},100%,${selected ? 92 : 80}%,${(selected ? 0.95 : 0.65) * alpha})`; ctx.stroke()
    ctx.restore()
  }

  private render() {
    this.background()
    const z = this.cam.z
    for (const n of this.nodes.values()) {
      const [x, y] = this.toScreen(n.x, n.y)
      const r = n.r * z
      const sel = this.selected === n.id
      const s = n.splitting
      if (!s) {
        this.drawNode(n, x, y, r, n.alpha, sel)
        continue
      }
      // Division: one membrane stretches, pinches at the waist, and parts (look test, approved).
      const p = ease(Math.min(1, s.p)), ux = Math.cos(s.ang), uy = Math.sin(s.ang)
      const rc = r * (1 - p * (1 - Math.SQRT1_2))
      if (p < 0.8) {
        const off = rc * (p / 0.8) * 0.985
        const k = 7 / rc
        this.shapeFn = a => {
          const c = Math.cos(a - s.ang), sn = Math.sin(a - s.ang)
          const lobe = (d: number) => { const q = rc * rc - d * d * sn * sn; return q > 0 ? d * c + Math.sqrt(q) : 0 }
          const l1 = lobe(off), l2 = lobe(-off), m = Math.max(l1, l2)
          return m + (Math.log(Math.exp(k * (l1 - m)) + Math.exp(k * (l2 - m))) / k) * 0.6
        }
        this.shapeR0 = rc
        this.drawNode(n, x, y, rc, n.alpha, false)
        this.shapeFn = null
      } else {
        const off = rc * (1 + ((p - 0.8) / 0.2) * 0.14)
        this.drawNode(n, x + ux * off, y + uy * off, rc, n.alpha, false)
        this.drawNode(n, x - ux * off, y - uy * off, rc, n.alpha, false)
      }
    }
  }
}

/** Node radius in world units from its USDC total. Square root keeps area proportional to value. */
function radiusOf(total: number) {
  return 10 + Math.sqrt(Math.max(0, total)) * 3.1
}

/** The roll curve's position, 0 to 1, from the node's fill and midpoint (mirrors the contract). */
function fillOf(total: number, mid: number) {
  const r = total / Math.max(mid, 1e-9)
  return (r * r) / (r * r + 1)
}
