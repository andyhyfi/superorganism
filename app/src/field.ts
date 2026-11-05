// The glow field: the network's simulation and camera. Drawing goes through Painter
// (PixiJS / WebGL, baked textures) so phones stay smooth. Look ported from the approved look test
// (private/sketches/look-test.html, look A). Chain state drives it; it never invents nodes.
import type { Address } from 'viem'
import type { ChainNode, NetEvent } from './chain'
import { Painter, hsl } from './painter'
import { SPECIES, hex, speciesOf } from './species'

const TAU = Math.PI * 2
const rand = (a: number, b: number) => a + Math.random() * (b - a)
const ease = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2)
const SPLIT_SECONDS = 3.4
const ZMIN = 0.15
const ZMAX = 6
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))

// Cells in a petri dish of very slowly moving water. Speeds are world units per second.
const WATER = {
  current: 5, // top speed of the drifting water (very slow)
  drag: 0.35, // how quickly a cell settles back into the water's drift after a bump
  bounce: 0.55, // how springy a bump is (0 = stops dead, 1 = perfect bounce)
  gap: 6, // space kept between membranes
  room: 1.9, // dish size relative to the cells it holds (bigger = more open water)
  emptyDrift: 9, // how fast an emptied cell drifts outward (px/s)
}

/** A cell at or below this many USDC counts as empty: it goes dark and drifts to the edge. */
const EMPTY = 0.000001

// Camera feel: lazy and comfortable, like moving underwater. Higher ease = snappier.
// ease/followEase/autoEase are rates per second (time to settle ~ 3 / rate seconds).
// The camera is a spring through water: it eases in, travels, and eases to a stop (no snap).
// Each value is the spring's stiffness; it settles in roughly 6 / value seconds.
const CAM = {
  ease: 4.2, // manual drag/zoom catching up to where the user sent it (~1.4 s)
  followEase: 2.8, // gliding over to a node you tapped (~2 s)
  autoEase: 2.0, // easing back to show the whole network (~3 s)
  glideCarry: 0.7, // how much of a flick's speed carries on after release
  glideDecay: 2.4, // how quickly that drift slows (lower = longer glide)
}

/** One axis of a critically damped spring: moves `p` toward `goal`, easing in and out. */
function spring(p: number, v: number, goal: number, w: number, dt: number): [number, number] {
  const a = w * w * (goal - p) - 2 * w * v
  v += a * dt
  return [p + v * dt, v]
}
const MAX_BUBBLES = 60

type Bubble = { a: number; d: number; amount: number; mine: boolean; w: number; in: number; out: boolean; user: string }

type VNode = {
  id: number
  x: number; y: number; vx: number; vy: number
  r: number
  total: number // USDC
  mid: number // roll-curve midpoint, USDC
  hue: number
  sp: number // species (look); placeholder: from lineage, later from mutations
  lit: number // 0..1, the selection light
  dim: number // 0..1, how far the cell has gone dark (empty cells)
  variant: number
  phase: number; spin: number
  bubbles: Bubble[]
  alpha: number
  splitting: null | { ang: number; p: number; c0: number; c1: number }
}

export type Pick = { id: number; total: number } | null

export class Field {
  private paint: Painter
  private W = 0
  private H = 0
  private t = 0
  private nodes = new Map<number, VNode>()
  // star flecks: z is depth (far ones are smaller, dimmer, slower); each drifts on its own heading
  private dust = Array.from({ length: 220 }, () => {
    const z = Math.pow(Math.random(), 1.6) * 0.85 + 0.15, h = rand(0, TAU)
    return { x: Math.random(), y: Math.random(), z, tw: rand(0, TAU), tws: rand(0.3, 1.1), hx: Math.cos(h), hy: Math.sin(h), warm: Math.random() < 0.18 }
  })
  private cam = { x: 0, y: 0, z: 1 }
  // Camera: 'auto' frames the whole network; 'manual' holds where the user put it; 'follow'
  // keeps one node centered. In Aquarium, manual eases back to auto after `autoReturnMs` idle.
  private camMode: 'auto' | 'manual' | 'follow' = 'auto'
  private follow: number | null = null
  private lastInput = 0
  private autoReturnMs: number | null = 15000
  private inset = { right: 0, bottom: 0 }
  private insetNow = { right: 0, bottom: 0 } // eases toward inset so panels never jolt the view
  private zoomTarget: number | null = null
  private vel = { x: 0, y: 0, z: 0 } // camera speed; zoom speed is in log space
  private raf = 0
  private last = 0
  private you: string
  selected: number | null = null
  onFrame: (() => void) | null = null

  constructor(private host: HTMLElement, you: Address) {
    this.paint = new Painter(host)
    this.you = you.toLowerCase()
    this.resize()
  }

  /** Resolves once the GPU renderer is up. */
  get ready() {
    return this.paint.init
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

  destroy() {
    this.stop()
    this.paint.destroy()
  }

  resize() {
    this.W = this.host.clientWidth
    this.H = this.host.clientHeight
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
    const path: number[] = []
    for (let n = c; n.id !== 0; n = chain[n.parent]) path.unshift(n.id)
    return {
      sp: speciesOf(path), variant: c.id, lit: 0, dim: total <= EMPTY ? 1 : 0,
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
        vx: ux * 18 * s, vy: uy * 18 * s, // the halves part gently, then the water takes over
        r: rc, total: n.total / 2, mid: n.mid,
        hue: n.hue + (id % 2 ? 9 : -9),
        sp: id % 2 === 0 ? (n.sp + 1 + (id % 5)) % SPECIES.length : n.sp, variant: id, lit: 0, dim: n.dim,
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

  private dishR = 0
  private view = { x: 0, y: 0, hw: 0, hh: 0 } // the overview frame in world units
  private fit = { z: 1, cx: 0, cy: 0 }

  /** How far a cell reaches from its center (a dividing cell is stretched along its axis). */
  private reach(n: VNode) {
    return n.r * (n.splitting ? 1.52 : 1.03)
  }

  private step(dt: number) {
    dt = Math.min(dt, 0.05) // a long pause (background tab) must not fling cells
    const t = this.t
    const toWater = 1 - Math.exp(-dt * WATER.drag)
    for (const n of this.nodes.values()) {
      if (!n.splitting) n.r += (radiusOf(n.total) - n.r) * Math.min(1, dt * 1.5)
      n.alpha += (1 - n.alpha) * Math.min(1, dt * 1.2)
      n.lit += ((this.selected === n.id ? 1 : 0) - n.lit) * Math.min(1, dt * 1.6)
      n.dim += ((n.total <= EMPTY ? 1 : 0) - n.dim) * Math.min(1, dt * 0.25) // fades over several seconds
      // very slow water: a gentle swirling current that changes over minutes
      const cx = Math.sin(n.y * 0.004 + t * 0.05) + 0.6 * Math.sin(n.x * 0.007 - t * 0.037 + 1.3)
      const cy = Math.cos(n.x * 0.004 - t * 0.045) + 0.6 * Math.cos(n.y * 0.006 + t * 0.031 + 2.1)
      let wx = cx * WATER.current / 1.6, wy = cy * WATER.current / 1.6
      if (n.dim > 0.05 && this.view.hw) {
        // empty: drifts slowly outward until it rests just inside the edge of the screen
        const dx = n.x - this.view.x, dy = n.y - this.view.y, d = Math.hypot(dx, dy) || 1
        const ux = dx / d, uy = dy / d
        const s = 1 / Math.max(Math.abs(ux) / this.view.hw, Math.abs(uy) / this.view.hh) // distance to the frame edge
        const rest = Math.max(0, s * 0.96 - n.r)
        const k = Math.max(0, Math.min(1, (rest - d) / 60)) * n.dim
        wx += ux * WATER.emptyDrift * k; wy += uy * WATER.emptyDrift * k
      }
      n.vx += (wx - n.vx) * toWater
      n.vy += (wy - n.vy) * toWater
      n.x += n.vx * dt
      n.y += n.vy * dt
    }

    // the dish: sized to the cells it holds, resizing slowly
    const list = [...this.nodes.values()]
    let area = 0
    for (const n of list) if (n.total > EMPTY) area += (this.reach(n) + WATER.gap) ** 2
    const want = Math.sqrt(area) * WATER.room + 40
    // grows at once when cells need room (so it never squeezes them together), shrinks slowly
    this.dishR = !this.dishR || want > this.dishR ? want : this.dishR + (want - this.dishR) * Math.min(1, dt * 0.2)

    // cells never overlap: push apart, then bounce (a few passes settle crowded spots)
    for (let pass = 0; pass < 4; pass++) {
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j]
        let dx = b.x - a.x, dy = b.y - a.y
        let d = Math.hypot(dx, dy)
        if (d < 1e-6) { dx = 1; dy = 0; d = 1e-6 }
        const min = this.reach(a) + this.reach(b) + WATER.gap
        if (d >= min) continue
        const ux = dx / d, uy = dy / d
        const ma = a.r * a.r, mb = b.r * b.r, wa = mb / (ma + mb), wb = ma / (ma + mb)
        const over = min - d
        a.x -= ux * over * wa; a.y -= uy * over * wa
        b.x += ux * over * wb; b.y += uy * over * wb
        const vn = (b.vx - a.vx) * ux + (b.vy - a.vy) * uy
        if (vn < 0 && pass === 0) {
          const jn = (-(1 + WATER.bounce) * vn) / (1 / ma + 1 / mb)
          a.vx -= (jn / ma) * ux; a.vy -= (jn / ma) * uy
          b.vx += (jn / mb) * ux; b.vy += (jn / mb) * uy
        }
      }
      // the dish wall
      for (const n of list) {
        const d = Math.hypot(n.x, n.y) || 1e-6
        // live cells stay inside the dish; empty ones may sit out in the band beyond it
        const lim = Math.max(this.dishR, n.total <= EMPTY ? Math.hypot(this.view.hw, this.view.hh) : 0) - this.reach(n)
        if (d <= lim) continue
        const ux = n.x / d, uy = n.y / d
        n.x = ux * Math.max(0, lim); n.y = uy * Math.max(0, lim)
        const vr = n.vx * ux + n.vy * uy
        if (vr > 0) { n.vx -= (1 + WATER.bounce) * vr * ux; n.vy -= (1 + WATER.bounce) * vr * uy }
      }
    }

    for (const n of list) {
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
    const ki = 1 - Math.exp(-dt * 2.2)
    this.insetNow.right += (this.inset.right - this.insetNow.right) * ki
    this.insetNow.bottom += (this.inset.bottom - this.insetNow.bottom) * ki
    {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    // frame the live cells; empty ones are left to drift out at the edges
    const hasLive = [...this.nodes.values()].some(n => n.total > EMPTY)
    for (const n of this.nodes.values()) {
      if (hasLive && n.total <= EMPTY) continue
      const pad = n.r * 1.6
      x0 = Math.min(x0, n.x - pad); y0 = Math.min(y0, n.y - pad)
      x1 = Math.max(x1, n.x + pad); y1 = Math.max(y1, n.y + pad)
    }
    const margin = 0.82
    const z = Math.min(1.6, (vw * margin) / (x1 - x0), (vh * margin) / (y1 - y0))
    this.fit = { z, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 }
    this.view = { x: (x0 + x1) / 2, y: (y0 + y1) / 2, hw: vw / 2 / z, hh: vh / 2 / z }
    }
    if (this.camMode === 'manual' && this.autoReturnMs != null && performance.now() - this.lastInput > this.autoReturnMs) {
      this.camMode = 'auto'
    }
    if (this.camMode === 'manual') {
      // Underwater: the view drifts toward where the user sent it and settles gently.
      if (!this.dragging && (this.glide.x || this.glide.y)) {
        this.goal.x += this.glide.x * dt
        this.goal.y += this.glide.y * dt
        const d = Math.exp(-dt * CAM.glideDecay)
        this.glide.x *= d; this.glide.y *= d
        if (Math.hypot(this.glide.x, this.glide.y) * this.cam.z < 2) this.glide = { x: 0, y: 0 }
      }
      this.moveCam(this.goal.x, this.goal.y, this.goal.z, CAM.ease, dt)
      return
    }
    if (this.camMode === 'follow') {
      const n = this.follow != null ? this.nodes.get(this.follow) : undefined
      if (!n) {
        this.camMode = 'auto'
        this.follow = null
      } else {
        const z = this.zoomTarget ?? Math.min(4, Math.min(vw, vh) * 0.32 / Math.max(n.r, 1))
        this.moveCam(n.x, n.y, z, CAM.followEase, dt)
        return
      }
    }
    this.moveCam(this.fit.cx, this.fit.cy, this.fit.z, CAM.autoEase, dt)
  }

  /** Springs the camera toward a target. Zoom moves in log space so in and out feel even. */
  private moveCam(x: number, y: number, z: number, w: number, dt: number) {
    ;[this.cam.x, this.vel.x] = spring(this.cam.x, this.vel.x, x, w, dt)
    ;[this.cam.y, this.vel.y] = spring(this.cam.y, this.vel.y, y, w, dt)
    const [lz, vz] = spring(Math.log(this.cam.z), this.vel.z, Math.log(z), w, dt)
    this.cam.z = Math.exp(lz)
    this.vel.z = vz
  }

  // ------------------------------------------------------------- controls
  // Input never moves the camera directly. It moves a goal; the camera eases toward it
  // (updateCamera), and a released drag keeps gliding and slows to a stop.

  private goal = { x: 0, y: 0, z: 1 }
  private glide = { x: 0, y: 0 } // world units per second
  private dragging = false
  private lastPan = 0

  /** A finger or button went down on the field: catch the view (stop any glide). */
  hold() {
    this.glide = { x: 0, y: 0 }
  }

  /** Move the view by screen pixels. `fromDrag` tracks speed so a release can glide. */
  pan(dx: number, dy: number, fromDrag = true) {
    this.takeManual()
    const wx = -dx / this.goal.z, wy = -dy / this.goal.z
    this.goal.x += wx
    this.goal.y += wy
    if (!fromDrag) return
    this.dragging = true
    const now = performance.now()
    const t = Math.max(8, now - this.lastPan) / 1000
    this.lastPan = now
    const vx = wx / t, vy = wy / t
    this.glide.x = this.glide.x * 0.6 + vx * 0.4
    this.glide.y = this.glide.y * 0.6 + vy * 0.4
  }

  /** The drag ended: glide on with the recent speed, gently. */
  release() {
    this.dragging = false
    if (performance.now() - this.lastPan > 90) this.glide = { x: 0, y: 0 } // finger rested before lifting
    else { this.glide.x *= CAM.glideCarry; this.glide.y *= CAM.glideCarry }
  }

  /** Zoom by `factor` around a screen point; that point ends up where it started. */
  zoomAt(px: number, py: number, factor: number) {
    if (this.camMode === 'follow') {
      this.zoomTarget = clamp((this.zoomTarget ?? this.cam.z) * factor, ZMIN, ZMAX)
      this.lastInput = performance.now()
      return
    }
    this.takeManual()
    const cx = (this.W - this.insetNow.right) / 2, cy = (this.H - this.insetNow.bottom) / 2
    const wx = (px - cx) / this.goal.z + this.goal.x, wy = (py - cy) / this.goal.z + this.goal.y
    this.goal.z = clamp(this.goal.z * factor, ZMIN, ZMAX)
    this.goal.x = wx - (px - cx) / this.goal.z
    this.goal.y = wy - (py - cy) / this.goal.z
  }

  /** Zoom by `factor` around the center of the visible area. */
  zoomBy(factor: number) {
    const cx = (this.W - this.insetNow.right) / 2, cy = (this.H - this.insetNow.bottom) / 2
    this.zoomAt(cx, cy, factor)
  }

  /** Glide over to a node and follow it. Coming from the overview it zooms in 50%;
   *  hopping from one followed node to another keeps the zoom and just glides across. */
  focus(id: number) {
    if (!this.nodes.has(id)) return
    if (this.camMode !== 'follow' || this.zoomTarget == null) this.zoomTarget = clamp(this.cam.z * 1.5, ZMIN, ZMAX)
    this.camMode = 'follow'
    this.follow = id
    this.glide = { x: 0, y: 0 }
    this.lastInput = performance.now()
  }

  /** Frame the whole network again. */
  fitAll() {
    this.camMode = 'auto'
    this.follow = null
    this.zoomTarget = null
    this.glide = { x: 0, y: 0 }
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
      // pick up from wherever the camera is now, mid-drift included
      this.camMode = 'manual'
      this.follow = null
      this.zoomTarget = null
      this.goal = { ...this.cam }
      this.glide = { x: 0, y: 0 }
    }
    this.lastInput = performance.now()
  }

  private toScreen(x: number, y: number): [number, number] {
    const cx = (this.W - this.insetNow.right) / 2, cy = (this.H - this.insetNow.bottom) / 2
    return [(x - this.cam.x) * this.cam.z + cx, (y - this.cam.y) * this.cam.z + cy]
  }

  private toWorld(px: number, py: number): [number, number] {
    const cx = (this.W - this.insetNow.right) / 2, cy = (this.H - this.insetNow.bottom) / 2
    return [(px - cx) / this.cam.z + this.cam.x, (py - cy) / this.cam.z + this.cam.y]
  }

  // ---------------------------------------------------------------- render

  private shapeFn: null | ((a: number) => number) = null
  private shapeR0 = 1

  private wob(n: VNode, ang: number, k: number) {
    const t = this.t
    return 1 + 0.018 * Math.sin(ang * 3 + t * 0.7 + n.phase) * k + 0.012 * Math.sin(ang * 5 - t * 0.5 + n.phase * 2) * k
  }

  /** The membrane outline as a flat point list, gently wobbling (and pinched while dividing). */
  private membranePts(n: VNode, x: number, y: number, r: number, k = 1): number[] {
    const pts: number[] = []
    const steps = r > 60 ? 96 : r > 20 ? 64 : 32
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * TAU
      const rr = (this.shapeFn ? this.shapeFn(a) * (r / this.shapeR0) : r) * this.wob(n, a, k)
      pts.push(x + Math.cos(a) * rr, y + Math.sin(a) * rr)
    }
    return pts
  }

  private background() {
    const { W, H, t, paint } = this
    paint.begin(W, H)
    for (const d of this.dust) {
      // slow float (a few px per second) plus a slight parallax with the camera
      const sp = 2.2 * d.z
      const x = ((((d.x * W + d.hx * t * sp - this.cam.x * this.cam.z * d.z * 0.08) % W) + W) % W)
      const y = ((((d.y * H + d.hy * t * sp - this.cam.y * this.cam.z * d.z * 0.08) % H) + H) % H)
      const tw = 0.5 + 0.5 * Math.sin(t * d.tws + d.tw)
      const a = (0.12 + 0.55 * tw * tw) * d.z
      paint.dust(x, y, 0.8 + d.z * 2.2, a, d.warm)
    }
  }

  private drawNode(
    n: VNode, x: number, y: number, r: number, alpha: number, _selected: boolean,
    lobes?: { ux: number; uy: number; off: number },
  ) {
    if (alpha <= 0.01 || r < 0.5) return
    // off screen: skip (glow reaches 2.1r, plus a dividing cell's lobe offset)
    const reach = r * 1.7 + (lobes?.off ?? 0)
    if (x + reach < 0 || y + reach < 0 || x - reach > this.W || y - reach > this.H) return
    const { paint } = this
    const sp = n.sp
    const drift = this.t * 0.02 * n.spin + n.phase // the body itself turns very slowly
    if (lobes) {
      // dividing: one glow, a body in each lobe; the outline below is the pinched membrane
      const { ux, uy, off } = lobes
      paint.glow(x, y, r + off * 0.6, sp, alpha)
      for (const sgn of [1, -1]) {
        const lx = x + ux * off * sgn, ly = y + uy * off * sgn
        paint.halo(lx, ly, r, sp, alpha * 0.6)
        paint.body(lx, ly, r, sp, n.variant, drift, alpha)
      }
    } else {
      const boost = 1 + 0.5 * n.lit
      const live = 1 - n.dim
      paint.glow(x, y, r, sp, alpha * (0.1 + 0.9 * live), boost)
      paint.halo(x, y, r, sp, alpha * (0.15 + 0.85 * live), boost)
      paint.body(x, y, r, sp, n.variant, drift, alpha * (0.55 + 0.45 * live), live)
      if (n.lit > 0.01) {
        // selected: light blooms from the middle of the cell, then breathes slowly
        const core = hex(SPECIES[sp].core)
        const breathe = 0.88 + 0.12 * Math.sin(this.t * 1.3)
        const k = n.lit * breathe * alpha
        paint.speck(x, y, r * 1.25 * (0.6 + 0.4 * n.lit), core, 0.38 * k)
        paint.speck(x, y, r * 0.55 * (0.5 + 0.5 * n.lit), core, 0.7 * k)
        paint.speck(x, y, r * 0.2, 0xffffff, 0.75 * k)
      }
    }
    const scale = Math.max(0.6, Math.min(1.6, this.cam.z))
    const other = hex(SPECIES[sp].speck), gold = hsl(42, 100, 70)
    for (const b of n.bubbles) {
      const bx = x + Math.cos(b.a) * b.d * r * 0.85, by = y + Math.sin(b.a) * b.d * r * 0.85
      const s = (1.2 + Math.sqrt(b.amount) * 0.32) * b.in * scale
      if (s < 0.2) continue
      paint.speck(bx, by, s * (b.mine ? 2.2 : 1.7), b.mine ? gold : other, (b.mine ? 0.95 : 0.38) * alpha * b.in)
    }
    paint.outline(
      this.membranePts(n, x, y, r),
      hex(SPECIES[sp].rim),
      0.22 * alpha * (1 - 0.6 * n.dim),
      1,
    )
  }

  /** Dev: draw one frame now and wait for the GPU (for timing). */
  benchFrame() {
    this.t += 1 / 60
    this.step(1 / 60)
    this.render()
    this.paint.finish()
  }

  private render() {
    if (!this.paint.isReady) return
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
        this.drawNode(n, x, y, rc, n.alpha, false, { ux, uy, off })
        this.shapeFn = null
      } else {
        const off = rc * (1 + ((p - 0.8) / 0.2) * 0.14)
        this.drawNode(n, x + ux * off, y + uy * off, rc, n.alpha, false)
        this.drawNode(n, x - ux * off, y - uy * off, rc, n.alpha, false)
      }
    }
    this.paint.end()
  }
}

/** Node radius in world units from its USDC total. Square root keeps area proportional to value. */
function radiusOf(total: number) {
  return 10 + Math.sqrt(Math.max(0, total)) * 3.1
}

/** The roll curve's position, 0 to 1, from the node's fill and midpoint (mirrors the contract). */
