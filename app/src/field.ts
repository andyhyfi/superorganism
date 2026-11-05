// The glow field: the network's simulation and camera. Drawing goes through Painter
// (PixiJS / WebGL, baked textures) so phones stay smooth. Look ported from the approved look test
// (private/sketches/look-test.html, look A). Chain state drives it; it never invents nodes.
import type { Address } from 'viem'
import type { ChainNode, LoanLink, NetEvent } from './chain'
import { Painter, hsl } from './painter'
import { SPECIES, hex, speciesOf } from './species'

const TAU = Math.PI * 2
const rand = (a: number, b: number) => a + Math.random() * (b - a)
const ease = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2)
const SPLIT_SECONDS = 2.6
const ZMIN = 0.15
const ZMAX = 6
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))

// Cells in a petri dish of very slowly moving water. Speeds are world units per second.
const WATER = {
  drag: 0.35, // how quickly a mid-size cell settles back into the water's drift after a bump
  dragSize: 30, // cells larger than this (world units) keep their momentum longer, smaller ones lose it sooner
  bounce: 0.55, // how springy a bump is (0 = stops dead, 1 = perfect bounce)
  gap: 3, // space kept between membranes
  room: 1.5, // dish size relative to the cells it holds (bigger = more open water)
  emptyDrift: 9, // how fast an empty cell drifts to its waiting ring (world units per second)
  emptyGap: 100, // open water between the main cluster's edge and the ring where empty cells wait
  emptyBand: 90, // how wide the waiting ring is; its outer edge is the outer boundary
  splitPush: 70, // how hard the two halves of a split push apart (they glide off, then the water slows them)
  shove: 9, // how much momentum a dividing cell gives the neighbors it pushes aside
  fadeSeconds: 4, // how long a dissipated cell takes to fade away
  escape: 4, // speed per unit of overlap a squeezed cell gets, so contact always beats the inward pull
}

// The galaxy swirl: the whole network turns slowly clockwise around the center and is drawn
// gently inward. A split or a withdrawal makes the network breathe out from the center; then the
// swirl slowly gathers it back. Speeds are world units per second.
const SWIRL = {
  spin: 7, // clockwise speed at the rim (inner cells turn more slowly)
  pull: 9, // inward drift toward the center; cells pack into one bundle and bump each other
  core: 30, // the pull fades out only inside this distance from the center
  noise: 1.2, // a little leftover current, so the motion never looks mechanical
  splitPulse: 0, // a split no longer breathes the network out: the dividing cell shoves its neighbors aside
  withdrawPulse: 0.5, // breath-out strength from a withdrawal
  pulsePush: 26, // outward speed at full breath
  pulseFade: 0.45, // how quickly a breath fades (lower = longer)
  maxPulse: 1.6,
}

/** A cell at or below this many USDC counts as empty: it goes dark and drifts to the edge. */
const EMPTY = 0.000001

// Camera feel: lazy and comfortable, like moving underwater. Higher ease = snappier.
// ease/followEase/autoEase are rates per second (time to settle ~ 3 / rate seconds).
// The camera is a spring through water: it eases in, travels, and eases to a stop (no snap).
// Each value is the spring's stiffness; it settles in roughly 6 / value seconds.
const CAM = {
  ease: 4.2, // manual drag/zoom catching up to where the user sent it (~1.4 s)
  followEase: 1.6, // gliding over to a node you tapped, and staying with it (~3.5 s)
  autoEase: 1.1, // easing back to show the whole network (~5 s)
  targetEase: 0.9, // the point the camera aims at glides too, so a target that jumps never jerks the view
  fitEase: 0.6, // the overview frame changes slowly (splits, new and leaving cells)
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
  fading?: number // 1 -> 0 while a dissipated cell fades away
  squeezed?: boolean // overlapping at the end of the last step: its inward pull eases until it is free
  dim: number // 0..1, how far the cell has gone dark (empty cells)
  variant: number
  phase: number; spin: number
  bubbles: Bubble[]
  alpha: number
  splitting: null | { ang: number; p: number; c0: number; c1: number }
}

export type Pick = { id: number; total: number } | null

/** A burst of energy travelling between two cells: a loan going out, or coming home. */
type Flow = { from: number; to: number; p: number; dur: number; sp: number; bow: number; size: number }

// Energy loans on screen. A loan is a faint filament from lender to borrower with specks drifting
// along it; a new loan and a repayment are a burst of specks travelling the filament.
const LOANS = {
  filament: 0.16, // brightness of the thread between two cells
  drift: 0.09, // how fast the specks along a thread travel (lengths per second)
  specks: 4, // specks along each thread
  burst: 10, // specks in a send or a return
  burstSeconds: 1.8, // how long a send or a return takes to cross
  bow: 0.18, // how far the thread curves out of a straight line
  selectedGlow: 2.6, // how much brighter a selected cell's threads get (eases with the selection light)
}

// Specks that orbit each cell along its thin outline, like the specks on loan threads.
const ORBIT = {
  min: 2, // specks on the smallest cell
  max: 6, // specks on the largest
  perRadius: 28, // one more speck per this many world units of radius
  speed: 0.16, // radians per second (one lap in about 40 s; direction follows the cell's own spin)
  brightness: 0.75, // speck brightness on a live cell (an empty cell's specks fade with it)
}

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
  /** Called when the selection moves on its own (a selected cell split into its first child). */
  onSelectionMoved?: (id: number) => void
  onFrame: (() => void) | null = null
  private links: LoanLink[] = []
  private flows: Flow[] = []
  private pulse = 0 // the breath-out level, from splits and withdrawals

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
    this.booted = true
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
      // a cell shows its energy: own deposits not lent out, plus energy borrowed from other cells
      const total = Number(c.energy) / 1e6
      const mid = Number(c.traits.rollMidFill) / 1e6
      if (c.split) {
        // A split node lives on screen only while its division animates.
        if (v && !v.splitting) {
          this.nodes.delete(c.id)
          if (this.selected === c.id) this.selected = null
        }
        continue
      }
      if (c.gone) {
        // dissipated: a cell on screen fades away where it waits, then leaves for good.
        // Replayed history (instant) or a cell long gone: removed at once.
        if (v && v.fading === undefined) {
          if (this.booted) v.fading = 1
          else { this.nodes.delete(c.id); if (this.selected === c.id) this.selected = null }
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

  /** False while the page builds the network from history; set by start(). */
  private booted = false

  /** Active loans, from chain. A loan that disappears (repaid, or due) sends its energy home. */
  setLinks(links: LoanLink[]) {
    const key = (l: LoanLink) => `${l.loanId}:${l.holder}`
    const next = new Set(links.map(key))
    const stillOut = new Set(links.map(l => l.loanId))
    for (const l of this.links) {
      if (next.has(key(l)) || stillOut.has(l.loanId)) continue // unchanged, or moved into a split's children
      this.flow(l.holder, l.lender, Number(l.amount) / 1e6)
    }
    this.links = links
  }

  /** The network breathes out from the center (splits, withdrawals). */
  private breathe(k: number) {
    this.pulse = Math.min(SWIRL.maxPulse, this.pulse + k)
  }

  private flow(from: number, to: number, amount: number) {
    const a = this.nodes.get(from), b = this.nodes.get(to)
    if (!a || !b || from === to) return
    this.flows.push({
      from, to, p: 0, dur: LOANS.burstSeconds, sp: a.sp,
      bow: (from < to ? 1 : -1) * LOANS.bow, size: 1.4 + Math.sqrt(amount) * 0.22,
    })
    if (this.flows.length > 40) this.flows.shift()
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
        if (!instant) this.breathe(SWIRL.withdrawPulse)
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
        else if (!n.splitting) {
          n.splitting = { ang: rand(0, TAU), p: 0, c0: e.c0, c1: e.c1 }
          this.breathe(SWIRL.splitPulse)
        }
      } else if (e.kind === 'loan' && !instant) {
        this.flow(e.lender, e.borrower, Number(e.amount) / 1e6)
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

  /** A node's species colors, for UI swatches (undefined if not on screen). */
  colorsOf(id: number) {
    const n = this.nodes.get(id)
    return n ? SPECIES[n.sp] : undefined
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
    const off = rc * splitEnd(rc) // where the pinch left each half: just touching
    const push = splitPushSpeed(n.r) // the speed the halves were already parting at
    const kids: VNode[] = [c0, c1].map((id, i) => {
      const s = i ? -1 : 1
      return {
        id,
        x: n.x + ux * off * s, y: n.y + uy * off * s,
        // the halves keep parting at the speed the pinch reached (no pause), on top of the parent's drift
        vx: n.vx + ux * push * s, vy: n.vy + uy * push * s,
        r: rc, total: n.total / 2, mid: n.mid,
        hue: n.hue + (id % 2 ? 9 : -9),
        sp: n.sp, variant: id, lit: 0, dim: n.dim, // both halves keep the parent's color
        phase: n.phase, spin: n.spin,
        // every claim halves into each child, so both children carry every depositor
        bubbles: n.bubbles.filter(b => !b.out).map(b => ({ ...b, amount: b.amount / 2, a: b.a + i * 1.3, in: 1 })),
        alpha: 1, splitting: null,
      }
    })
    this.nodes.delete(n.id)
    for (const k of kids) this.nodes.set(k.id, k)
    // the selection and the camera stay with the line: the first child takes over, already lit
    if (this.selected === n.id) {
      this.selected = c0
      const k0 = this.nodes.get(c0)
      if (k0) k0.lit = n.lit
      this.onSelectionMoved?.(c0)
    }
    if (this.follow === n.id) this.follow = c0
  }

  private dishR = 0
  private outerR = 0 // the outer boundary: empty cells wait inside it
  private clusterR = 0 // the main cluster's size
  private fit = { z: 1, cx: 0, cy: 0 }
  private fitReady = false
  private aim: { x: number; y: number; z: number } | null = null // the smoothed point the camera springs toward

  /** How far a cell reaches from its center (a dividing cell is stretched along its axis). */
  private reach(n: VNode) {
    const s = n.splitting
    if (!s) return n.r * 1.03
    // a dividing cell grows along its axis as the halves part: lobe offset plus a lobe's radius
    const raw = Math.min(1, s.p)
    const rc = n.r * (1 - ease(raw) * (1 - Math.SQRT1_2))
    return rc * (1.03 + Math.pow(raw, splitExponent(n.r)) * splitEnd(rc))
  }

  private step(dt: number) {
    dt = Math.min(dt, 0.05) // a long pause (background tab) must not fling cells
    const t = this.t
    this.pulse *= Math.exp(-dt * SWIRL.pulseFade)
    // the bundle's size: the spin is full speed at its edge and slower inside
    let packed = 0
    for (const n of this.nodes.values()) if (n.total > EMPTY) packed += (this.reach(n) + WATER.gap) ** 2
    const rest = Math.max(60, Math.sqrt(packed))
    this.clusterR = rest
    const outerWant = rest + WATER.emptyGap + WATER.emptyBand + 20
    this.outerR = !this.outerR ? outerWant : this.outerR + (outerWant - this.outerR) * Math.min(1, dt * 0.3)
    for (const n of this.nodes.values()) {
      if (!n.splitting) n.r += (radiusOf(n.total) - n.r) * Math.min(1, dt * 1.5)
      if (n.fading !== undefined) {
        n.fading = Math.max(0, n.fading - dt / WATER.fadeSeconds)
        n.alpha = n.fading
        n.r *= 1 + dt * 0.08 // swells slightly as it disperses
      } else n.alpha += (1 - n.alpha) * Math.min(1, dt * 1.2)
      n.lit += ((this.selected === n.id ? 1 : 0) - n.lit) * Math.min(1, dt * 1.6)
      n.dim += ((n.total <= EMPTY ? 1 : 0) - n.dim) * Math.min(1, dt * 0.25) // fades over several seconds
      // very slow water: a gentle swirling current that changes over minutes
      const cx = Math.sin(n.y * 0.004 + t * 0.05) + 0.6 * Math.sin(n.x * 0.007 - t * 0.037 + 1.3)
      const cy = Math.cos(n.x * 0.004 - t * 0.045) + 0.6 * Math.cos(n.y * 0.006 + t * 0.031 + 2.1)
      let wx = cx * SWIRL.noise / 1.6, wy = cy * SWIRL.noise / 1.6
      {
        // galaxy swirl: clockwise on screen (y points down), drawn in, breathing out on events
        const d = Math.hypot(n.x, n.y) || 1e-6, ux = n.x / d, uy = n.y / d
        const turn = SWIRL.spin * Math.min(1, d / rest)
        // every live cell is drawn toward the center, so they bundle and press on each other
        // a cell that just came back to life (deposit or borrowed energy) eases in as it brightens
        // a squeezed cell (overlapping last frame) stops pulling inward until it is free
        const inward = n.total > EMPTY ? SWIRL.pull * Math.min(1, d / SWIRL.core) * (1 - 0.85 * n.dim) * (n.squeezed ? 0.2 : 1) : 0
        const out = SWIRL.pulsePush * this.pulse * Math.min(1, d / 80 + 0.3)
        wx += -uy * turn + ux * (out - inward)
        wy += ux * turn + uy * (out - inward)
      }
      if (n.total <= EMPTY) {
        // empty: drifts to the waiting ring around the main cluster and circles there with the swirl
        const d = Math.hypot(n.x, n.y) || 1e-6, ux = n.x / d, uy = n.y / d
        const inner = rest + WATER.emptyGap, outer = inner + WATER.emptyBand
        const want = d < inner ? inner - d : d > outer ? outer - d : 0
        // inside the cluster it works its way out faster (live cells shoulder it aside)
        const k = d < rest ? 4 : Math.max(-1, Math.min(1, want / 40))
        wx += ux * WATER.emptyDrift * k; wy += uy * WATER.emptyDrift * k
      }
      const settle = 1 - Math.exp(-dt * WATER.drag * Math.min(3, WATER.dragSize / Math.max(n.r, 6)))
      n.vx += (wx - n.vx) * settle
      n.vy += (wy - n.vy) * settle
      n.x += n.vx * dt
      n.y += n.vy * dt
    }

    for (const [id, n] of this.nodes) {
      if (n.fading !== undefined && n.fading <= 0) {
        this.nodes.delete(id)
        if (this.selected === id) this.selected = null
        this.links = this.links.filter(l => l.lender !== id && l.holder !== id)
      }
    }

    // the dish: sized to the cells it holds, resizing slowly
    const list = [...this.nodes.values()]
    let area = 0
    for (const n of list) if (n.total > EMPTY) area += (this.reach(n) + WATER.gap) ** 2
    const want = Math.sqrt(area) * WATER.room + 40
    // grows at once when cells need room (so it never squeezes them together), shrinks slowly
    this.dishR = !this.dishR || want > this.dishR ? want : this.dishR + (want - this.dishR) * Math.min(1, dt * 0.2)

    // cells never overlap: push apart, then bounce (a few passes settle crowded spots)
    for (const n of list) n.squeezed = false
    for (let pass = 0; pass < 4; pass++) {
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j]
        let dx = b.x - a.x, dy = b.y - a.y
        let d = Math.hypot(dx, dy)
        if (d < 1e-6) { dx = 1; dy = 0; d = 1e-6 }
        const min = this.reach(a) + this.reach(b) + WATER.gap
        if (d >= min) continue
        const ux = dx / d, uy = dy / d
        // mass grows with area, so a big cell shoves a small one far and barely moves itself
        // an empty cell (a husk) is light at the ring, so live cells push it aside easily. Inside the
        // cluster it is heavy instead: live cells flow around it while it rises out, like a bubble
        const husk = (n: VNode) => n.total <= EMPTY ? (Math.hypot(n.x, n.y) < this.clusterR * 0.95 ? 6 : 0.15) : 1
        const ma = a.r * a.r * husk(a), mb = b.r * b.r * husk(b)
        const wa = mb / (ma + mb), wb = ma / (ma + mb)
        const over = min - d
        if (pass === 3 && over > 1) { a.squeezed = true; b.squeezed = true }
        a.x -= ux * over * wa; a.y -= uy * over * wa
        b.x += ux * over * wb; b.y += uy * over * wb
        // contact always beats the inward pull: the pushed cell gets an outward speed larger than
        // the pull, so a small cell squeezed between big ones escapes instead of sticking
        if (pass === 0) {
          const esc = Math.min(over, 12) * WATER.escape
          a.vx -= ux * esc * wa; a.vy -= uy * esc * wa
          b.vx += ux * esc * wb; b.vy += uy * esc * wb
        }
        if (a.splitting || b.splitting) {
          // a dividing cell shoves its neighbors: they glide away with momentum, small ones further
          const k = WATER.shove
          a.vx -= ux * over * wa * k; a.vy -= uy * over * wa * k
          b.vx += ux * over * wb * k; b.vy += uy * over * wb * k
        }
        const vn = (b.vx - a.vx) * ux + (b.vy - a.vy) * uy
        if (vn < 0) {
          const jn = (-(1 + WATER.bounce) * vn) / (1 / ma + 1 / mb)
          a.vx -= (jn / ma) * ux; a.vy -= (jn / ma) * uy
          b.vx += (jn / mb) * ux; b.vy += (jn / mb) * uy
        }
      }
      // the dish wall
      for (const n of list) {
        const d = Math.hypot(n.x, n.y) || 1e-6
        // live cells stay inside the dish; empty ones stay inside the outer boundary
        const lim = Math.max(this.dishR, n.total <= EMPTY ? this.outerR : 0) - this.reach(n)
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
    for (const f of this.flows) f.p += dt / f.dur
    this.flows = this.flows.filter(f => f.p < 1 + 0.5) // the last specks arrive half a crossing later
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
    // the overview frames every cell: the main cluster and the empty cells waiting on the ring
    for (const n of this.nodes.values()) {
      const pad = n.r * 1.6
      x0 = Math.min(x0, n.x - pad); y0 = Math.min(y0, n.y - pad)
      x1 = Math.max(x1, n.x + pad); y1 = Math.max(y1, n.y + pad)
    }
    const margin = 0.82
    const z = Math.min(1.6, (vw * margin) / (x1 - x0), (vh * margin) / (y1 - y0))
    const want = { z, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 }
    // the frame itself eases, so cells appearing or leaving never jolt the overview
    if (!this.fitReady) { this.fit = want; this.fitReady = true }
    else {
      const k = 1 - Math.exp(-dt * CAM.fitEase)
      this.fit = { z: Math.exp(Math.log(this.fit.z) + (Math.log(want.z) - Math.log(this.fit.z)) * k),
        cx: this.fit.cx + (want.cx - this.fit.cx) * k, cy: this.fit.cy + (want.cy - this.fit.cy) * k }
    }
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
      this.aim = { x: this.cam.x, y: this.cam.y, z: this.cam.z } // later modes start from here, no jump
      return
    }
    if (this.camMode === 'follow') {
      const n = this.follow != null ? this.nodes.get(this.follow) : undefined
      if (!n) {
        this.camMode = 'auto'
        this.follow = null
      } else {
        const z = this.zoomTarget ?? Math.min(4, Math.min(vw, vh) * 0.32 / Math.max(n.r, 1))
        // a split hands the camera to a child that sits elsewhere: the aim glides there
        const a = this.smoothAim(n.x, n.y, z, dt)
        this.moveCam(a.x, a.y, a.z, CAM.followEase, dt)
        return
      }
    }
    const a = this.smoothAim(this.fit.cx, this.fit.cy, this.fit.z, dt)
    this.moveCam(a.x, a.y, a.z, CAM.autoEase, dt)
  }

  /** The aim point eases toward its target, so the camera never chases a jump. */
  private smoothAim(x: number, y: number, z: number, dt: number) {
    if (!this.aim) this.aim = { x: this.cam.x, y: this.cam.y, z: this.cam.z }
    const k = 1 - Math.exp(-dt * CAM.targetEase * 3)
    this.aim.x += (x - this.aim.x) * k
    this.aim.y += (y - this.aim.y) * k
    this.aim.z = Math.exp(Math.log(this.aim.z) + (Math.log(z) - Math.log(this.aim.z)) * k)
    return this.aim
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
    if (!lobes) this.drawOrbit(n, x, y, r, alpha)
  }

  /** Specks gliding around the cell on its outline, each breathing slowly in and out. */
  private drawOrbit(n: VNode, x: number, y: number, r: number, alpha: number) {
    const live = 1 - n.dim
    const a0 = ORBIT.brightness * alpha * (0.15 + 0.85 * live)
    if (a0 < 0.01 || r < 4) return
    const count = Math.min(ORBIT.max, ORBIT.min + Math.floor(n.r / ORBIT.perRadius))
    const speck = hex(SPECIES[n.sp].speck), core = hex(SPECIES[n.sp].core)
    const scale = Math.max(0.6, Math.min(1.6, this.cam.z))
    const size = (1.7 + Math.sqrt(Math.max(0, n.total)) * 0.06) * scale * (1 + 0.35 * n.lit)
    for (let k = 0; k < count; k++) {
      // uneven spacing and a slight speed difference per speck, so they drift past each other
      const ang = n.phase * 3 + (k / count) * TAU + Math.sin(k * 2.1 + n.phase) * 0.5
        + this.t * ORBIT.speed * Math.sign(n.spin) * (1 + 0.18 * Math.sin(k * 1.7 + n.variant))
      const rr = r * this.wob(n, ang, 1)
      const px = x + Math.cos(ang) * rr, py = y + Math.sin(ang) * rr
      const breathe = 0.55 + 0.45 * Math.sin(this.t * (0.5 + 0.13 * k) + k * 1.9 + n.phase)
      const a = Math.min(1, a0 * breathe * (1 + 0.6 * n.lit))
      this.paint.speck(px, py, size, speck, a)
      this.paint.speck(px, py, size * 2.6, core, 0.26 * a)
    }
  }

  /** A point on the curved thread from cell a to cell b, membrane to membrane. q runs 0 to 1. */
  private threadAt(a: VNode, b: VNode, bow: number, q: number): [number, number] {
    const [ax, ay] = this.toScreen(a.x, a.y), [bx, by] = this.toScreen(b.x, b.y)
    const z = this.cam.z, dx = bx - ax, dy = by - ay, d = Math.hypot(dx, dy) || 1
    const ux = dx / d, uy = dy / d
    const sx = ax + ux * a.r * z, sy = ay + uy * a.r * z
    const ex = bx - ux * b.r * z, ey = by - uy * b.r * z
    const cx = (sx + ex) / 2 - uy * d * bow, cy = (sy + ey) / 2 + ux * d * bow
    const m = 1 - q
    return [m * m * sx + 2 * m * q * cx + q * q * ex, m * m * sy + 2 * m * q * cy + q * q * ey]
  }

  private drawLoans() {
    const { paint } = this
    const scale = Math.max(0.6, Math.min(1.6, this.cam.z))
    for (const l of this.links) {
      const a = this.nodes.get(l.lender), b = this.nodes.get(l.holder)
      if (!a || !b || a.splitting || b.splitting) continue
      if (Math.hypot(b.x - a.x, b.y - a.y) - a.r - b.r < 14) continue // touching cells: no room for a thread
      const amount = Number(l.amount) / 1e6
      const bow = (l.loanId % 2 ? 1 : -1) * LOANS.bow
      const rim = hex(SPECIES[a.sp].rim), speck = hex(SPECIES[a.sp].speck), core = hex(SPECIES[a.sp].core)
      // a selected cell's threads glow, easing in and out with the cell's own selection light
      const lit = Math.max(a.lit, b.lit)
      const boost = 1 + (LOANS.selectedGlow - 1) * lit
      const pts: number[] = []
      for (let i = 0; i <= 24; i++) pts.push(...this.threadAt(a, b, bow, i / 24))
      const base = LOANS.filament * Math.min(1, 0.4 + amount / 60)
      if (lit > 0.01) paint.line(pts, rim, Math.min(0.5, base * 0.9 * lit), 4 + 3 * lit) // soft bloom under the thread
      paint.line(pts, rim, Math.min(0.9, base * boost), 1.2 + 0.6 * lit)
      for (let k = 0; k < LOANS.specks; k++) {
        const q = (this.t * LOANS.drift + k / LOANS.specks + l.loanId * 0.37) % 1
        const [x, y] = this.threadAt(a, b, bow, q)
        const fade = Math.sin(q * Math.PI)
        const r = (1.2 + Math.sqrt(amount) * 0.18) * scale * (1 + 0.35 * lit)
        paint.speck(x, y, r, speck, Math.min(1, 0.55 * fade * (1 + 0.6 * lit)))
        if (lit > 0.01) paint.speck(x, y, r * 2.4, core, 0.22 * fade * lit)
      }
    }
    for (const f of this.flows) {
      const a = this.nodes.get(f.from), b = this.nodes.get(f.to)
      if (!a || !b) continue
      const speck = hex(SPECIES[f.sp].core)
      for (let k = 0; k < LOANS.burst; k++) {
        const q = f.p - (k / LOANS.burst) * 0.5
        if (q <= 0 || q >= 1) continue
        const e = ease(q)
        const [x, y] = this.threadAt(a, b, f.bow, e)
        paint.speck(x, y, f.size * scale * (1 - k / (LOANS.burst * 1.6)), speck, 0.85 * Math.sin(q * Math.PI))
      }
    }
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
    this.drawLoans()
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
      const raw = Math.min(1, s.p)
      const p = ease(raw), ux = Math.cos(s.ang), uy = Math.sin(s.ang)
      const rc = r * (1 - p * (1 - Math.SQRT1_2))
      {
        // the lobes part slowly, then faster and faster, and hand off to the physics at full speed
        const off = rc * Math.pow(raw, splitExponent(n.r)) * splitEnd(rc / z)
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
      }
    }
    this.paint.end()
  }
}

/** How far apart (in radii) the halves sit at the hand-off: membranes just touching, so the
 *  no-overlap rule takes over without a jump. */
function splitEnd(rc: number) {
  return 1.03 + WATER.gap / (2 * Math.max(rc, 1))
}

/** How sharply a split's lobes accelerate apart. They start moving at once, speed up through the
 *  pinch, and hand off to the physics at the speed they reached, so the parting never pauses. */
function splitExponent(r: number) {
  return Math.max(1.6, Math.min(3, (WATER.splitPush * SPLIT_SECONDS) / (r * Math.SQRT1_2 * splitEnd(r * Math.SQRT1_2))))
}

/** The speed (world units per second) the halves are parting at when they become separate cells. */
function splitPushSpeed(r: number) {
  return (r * Math.SQRT1_2 * splitEnd(r * Math.SQRT1_2) * splitExponent(r)) / SPLIT_SECONDS
}

/** Node radius in world units from its USDC total. Square root keeps area proportional to value. */
function radiusOf(total: number) {
  return 10 + Math.sqrt(Math.max(0, total)) * 3.1
}

/** The roll curve's position, 0 to 1, from the node's fill and midpoint (mirrors the contract). */
