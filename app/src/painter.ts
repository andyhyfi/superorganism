// GPU painter for the field (PixiJS / WebGL). Immediate-mode: each frame the field calls
// glow/body/spiral/speck/outline, the painter places pooled sprites, then renders once.
// Every soft shape is a texture baked once at startup, so a frame is just sprite placement:
// cheap on phones. Everything but the background is additive, so draw order doesn't matter.
import { Application, Container, Graphics, Sprite, Texture } from 'pixi.js'
import { bakeBackdrop, bakeCell, bakeHalo } from './cellArt'
import { SPECIES, hex } from './species'

const TAU = Math.PI * 2
const SPIRAL_LEVELS = 8 // spiral tightness steps, baked once each

/** hsl(h, s%, l%) to 0xRRGGBB. */
export function hsl(h: number, s: number, l: number): number {
  h = ((h % 360) + 360) % 360; s /= 100; l /= 100
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255)
}

function bake(size: number, draw: (c: CanvasRenderingContext2D, s: number) => void): Texture {
  const cv = document.createElement('canvas')
  cv.width = cv.height = size
  draw(cv.getContext('2d')!, size)
  return Texture.from(cv)
}

/** A white soft dot: alpha 1 at the center to 0 at the edge (tinted per use). */
const bakeDot = () => bake(64, (c, s) => {
  const g = c.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2)
  g.addColorStop(0, '#fff'); g.addColorStop(1, 'rgba(255,255,255,0)')
  c.fillStyle = g; c.fillRect(0, 0, s, s)
})

/** The halo around a cell: from 1/3 of its radius outward (matches 0.7r..2.1r). */
const bakeGlow = () => bake(128, (c, s) => {
  const m = s / 2
  const g = c.createRadialGradient(m, m, m / 3, m, m, m)
  g.addColorStop(0, '#fff'); g.addColorStop(1, 'rgba(255,255,255,0)')
  c.fillStyle = g; c.fillRect(0, 0, s, s)
})

/** Three spiral arms, white, reaching 0.92 of the texture radius (tinted and faded per use). */
const bakeSpiral = (turns: number) => bake(256, (c, s) => {
  const m = s / 2, R = m * 0.92
  c.strokeStyle = '#fff'; c.lineWidth = 1.0; c.lineCap = 'round'
  for (let k = 0; k < 3; k++) {
    c.beginPath()
    for (let i = 0; i <= 90; i++) {
      const p = i / 90, rr = R * Math.pow(p, 0.8)
      const a = (k / 3) * TAU + p * turns * TAU
      if (i) c.lineTo(m + Math.cos(a) * rr, m + Math.sin(a) * rr)
      else c.moveTo(m, m)
    }
    c.stroke()
  }
})

/** A pool of sprites on one layer; unused ones hide at the end of a frame. */
class Pool {
  private items: Sprite[] = []
  private used = 0
  constructor(private layer: Container, private additive = true) {}
  take(tex: Texture): Sprite {
    let s = this.items[this.used]
    if (!s) {
      s = new Sprite(tex)
      s.anchor.set(0.5)
      if (this.additive) s.blendMode = 'add'
      this.layer.addChild(s)
      this.items.push(s)
    }
    if (s.texture !== tex) s.texture = tex
    s.visible = true
    this.used++
    return s
  }
  end() {
    for (let i = this.used; i < this.items.length; i++) this.items[i].visible = false
    this.used = 0
  }
}

export class Painter {
  private app = new Application()
  private ready = false
  private destroyed = false
  private tex!: { dot: Texture; glow: Texture; halo: Texture; spiral: Texture[]; bg: Texture; body: Map<number, Texture> }
  private bg!: Sprite
  private pools!: { dust: Pool; glow: Pool; halo: Pool; body: Pool; spiral: Pool; speck: Pool }
  private lines!: Graphics
  readonly init: Promise<void>

  constructor(host: HTMLElement) {
    this.init = this.app.init({
      resizeTo: host,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
      antialias: true,
      background: '#000001',
      preference: 'webgl',
      autoStart: false,
      sharedTicker: false,
      powerPreference: 'high-performance',
    }).then(() => {
      if (this.destroyed) { this.app.destroy(true); return }
      const cv = this.app.canvas as HTMLCanvasElement
      cv.style.display = 'block'; cv.style.width = '100%'; cv.style.height = '100%'
      host.appendChild(cv)
      // PixiJS adds an invisible off-screen button on phones for its own accessibility layer.
      // The field has no Pixi-level content to expose (the panels are real HTML), so drop it.
      const a11y = (this.app.renderer as unknown as { accessibility?: { _destroyTouchHook?: () => void } }).accessibility
      a11y?._destroyTouchHook?.()
      this.tex = {
        dot: bakeDot(), glow: bakeGlow(), halo: Texture.from(bakeHalo()), bg: Texture.from(bakeBackdrop()), body: new Map(),
        spiral: Array.from({ length: SPIRAL_LEVELS }, (_, i) => bakeSpiral(0.5 + (i / (SPIRAL_LEVELS - 1)) * 3.2)),
      }
      const stage = this.app.stage
      this.bg = new Sprite(this.tex.bg); this.bg.anchor.set(0.5); stage.addChild(this.bg)
      const layer = () => stage.addChild(new Container())
      this.pools = {
        dust: new Pool(layer(), false), glow: new Pool(layer()), halo: new Pool(layer()), body: new Pool(layer(), false),
        spiral: new Pool(layer()), speck: new Pool(layer()),
      }
      this.lines = new Graphics(); this.lines.blendMode = 'add'; stage.addChild(this.lines)
      this.ready = true
    })
  }

  get isReady() { return this.ready }

  begin(W: number, H: number) {
    const s = Math.max(W, H) * 1.15
    this.bg.position.set(W / 2, H / 2); this.bg.width = this.bg.height = s
    this.lines.clear()
  }

  dust(x: number, y: number, size: number, alpha: number) {
    const s = this.pools.dust.take(Texture.WHITE)
    s.position.set(x, y); s.width = s.height = size; s.tint = 0xaac8ff; s.alpha = alpha
  }

  /** Wide soft glow in the cell's rim color; `boost` brightens it (selected cell). */
  glow(x: number, y: number, r: number, sp: number, alpha: number, boost = 1) {
    const s = this.pools.glow.take(this.tex.glow)
    s.position.set(x, y); s.width = s.height = r * 2.8; s.tint = hex(SPECIES[sp].rim); s.alpha = 0.07 * alpha * boost
  }

  /** Tight bright band just outside the membrane. */
  halo(x: number, y: number, r: number, sp: number, alpha: number, boost = 1) {
    const s = this.pools.halo.take(this.tex.halo)
    s.position.set(x, y); s.width = s.height = r * 3.2; s.tint = hex(SPECIES[sp].rim); s.alpha = 0.16 * alpha * boost
  }

  /** The cell body for a species (baked once per species and variant, then reused). */
  body(x: number, y: number, r: number, sp: number, variant: number, rot: number, alpha: number) {
    const key = sp * 4 + (variant & 3)
    let t = this.tex.body.get(key)
    if (!t) { t = Texture.from(bakeCell(SPECIES[sp], 1000 + key * 7919)); this.tex.body.set(key, t) }
    const s = this.pools.body.take(t)
    s.position.set(x, y); s.width = s.height = r * 2; s.rotation = rot; s.tint = 0xffffff; s.alpha = alpha
  }

  /** A faint slow swirl inside the body; fill 0..1 picks how tight it is. */
  spiral(x: number, y: number, r: number, fill: number, rot: number, sp: number, alpha: number) {
    const i = Math.round(Math.max(0, Math.min(1, fill)) * (SPIRAL_LEVELS - 1))
    const s = this.pools.spiral.take(this.tex.spiral[i])
    s.position.set(x, y); s.width = s.height = r * 1.8; s.rotation = rot
    s.tint = hex(SPECIES[sp].core); s.alpha = (0.03 + fill * 0.05) * alpha
  }

  speck(x: number, y: number, radius: number, color: number, alpha: number) {
    const s = this.pools.speck.take(this.tex.dot)
    s.position.set(x, y); s.width = s.height = radius * 2; s.tint = color; s.alpha = alpha
  }

  outline(pts: number[], color: number, alpha: number, width: number) {
    this.lines.poly(pts, true).stroke({ width, color, alpha })
  }

  end() {
    for (const p of Object.values(this.pools)) p.end()
    this.app.render()
  }

  /** GPU sync for benchmarks: waits for the frame to finish drawing. */
  finish() {
    const gl = (this.app.renderer as unknown as { gl?: WebGL2RenderingContext }).gl
    gl?.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4))
  }

  destroy() {
    this.destroyed = true
    if (this.ready) this.app.destroy(true, { children: true, texture: true })
  }
}
