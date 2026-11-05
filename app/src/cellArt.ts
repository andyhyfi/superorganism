// Bakes Osmos-style cell textures once per species: a mottled body with radial filaments,
// a bright core knot, a glowing rim, and a soft glossy highlight top-left. Done on a 2D canvas
// pixel by pixel at startup (a few ms each), then handed to the GPU as a plain texture.
import type { Species } from './species'

const rgb = (c: string) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const smooth = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t) }

/** Small seeded value noise, tileable in angle so filaments wrap cleanly. */
function makeNoise(seed: number) {
  const N = 256
  const p = new Float32Array(N * N)
  let s = seed >>> 0 || 1
  for (let i = 0; i < p.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; p[i] = s / 4294967296 }
  const at = (x: number, y: number) => p[((y & (N - 1)) * N) + (x & (N - 1))]
  return (x: number, y: number) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf)
    return lerp(lerp(at(xi, yi), at(xi + 1, yi), u), lerp(at(xi, yi + 1), at(xi + 1, yi + 1), u), v)
  }
}

function fbm(n: (x: number, y: number) => number, x: number, y: number, oct: number) {
  let a = 0.5, f = 1, sum = 0, norm = 0
  for (let i = 0; i < oct; i++) { sum += a * n(x * f, y * f); norm += a; a *= 0.5; f *= 2.03 }
  return sum / norm
}

/** One cell body, `size` px square, transparent outside the circle. */
export function bakeCell(sp: Species, seed: number, size = 256): HTMLCanvasElement {
  const cv = document.createElement('canvas')
  cv.width = cv.height = size
  const ctx = cv.getContext('2d')!
  const img = ctx.createImageData(size, size)
  const d = img.data
  const noise = makeNoise(seed)
  const dark = rgb(sp.dark), light = rgb(sp.light), core = rgb(sp.core), rim = rgb(sp.rim)
  const m = size / 2

  const warm = core // core is a soft warm glow, not a white dot
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - m) / m, dy = (y + 0.5 - m) / m
      const r = Math.hypot(dx, dy)
      if (r > 1) continue
      // domain warp so nothing looks radially perfect
      const wx = fbm(noise, dx * 1.6 + 3, dy * 1.6 + 9, 2) - 0.5
      const wy = fbm(noise, dx * 1.6 + 17, dy * 1.6 + 1, 2) - 0.5
      const ux = dx + wx * 0.35, uy = dy + wy * 0.35
      // clouds ~0.15 R
      const mot = fbm(noise, ux * 3.4 + 11, uy * 3.4 + 7, 4)
      // filaments: streaks running straight outward (no swirl)
      const ang = (Math.atan2(uy, ux) / (Math.PI * 2) + 0.5) * 40
      const fil = Math.pow(fbm(noise, ang, r * 2.6 + 40, 3), 1.4)
      let t = lerp(mot, fil * 1.3, sp.fil * 0.8)
      t = smooth(0.22, 0.82, t)
      // dark blotches: low clouds drop well below the base tone
      const blot = smooth(0.42, 0.3, fbm(noise, ux * 2.2 + 50, uy * 2.2 + 50, 3))
      t *= 1 - 0.75 * blot
      // calmer, darker band before the rim
      t *= 1 - 0.4 * smooth(0.6, 0.86, r)

      let cr = lerp(dark[0] * 0.6, light[0], t), cg = lerp(dark[1] * 0.6, light[1], t), cb = lerp(dark[2] * 0.6, light[2], t)

      // soft warm core ~0.3 R, emerging from the texture
      const k = 0.75 * Math.exp(-Math.pow(r / (sp.coreSize * 2.4), 2)) * (0.6 + 0.6 * fil)
      cr = lerp(cr, warm[0], Math.min(1, k)); cg = lerp(cg, warm[1], Math.min(1, k)); cb = lerp(cb, warm[2], Math.min(1, k))

      // thick soft rim: starts ~0.78 R, brightest at the edge
      const rimT = Math.pow(smooth(0.76, 0.985, r), 1.6)
      cr = lerp(cr, rim[0], rimT); cg = lerp(cg, rim[1], rimT); cb = lerp(cb, rim[2], rimT)

      // glossy crescent upper-left, inside the rim, tinted toward the rim color
      const lit = Math.max(0, (-dx * 0.62 - dy * 0.78))       // facing the light
      const band = smooth(0.66, 0.84, r) * (1 - smooth(0.9, 0.99, r))
      const gloss = band * Math.pow(lit, 1.5) * 0.5
      cr = lerp(cr, lerp(255, rim[0], 0.35), gloss); cg = lerp(cg, lerp(255, rim[1], 0.35), gloss); cb = lerp(cb, lerp(255, rim[2], 0.35), gloss)

      const alpha = (0.86 + 0.14 * rimT) * (1 - smooth(0.985, 1, r))
      const i = (y * size + x) * 4
      d[i] = cr; d[i + 1] = cg; d[i + 2] = cb; d[i + 3] = alpha * 255
    }
  }
  ctx.putImageData(img, 0, 0)
  return cv
}

/** The halo outside the rim: tight bright band fading out to ~1.35 R (texture radius = 1.6 R). */
export function bakeHalo(size = 256): HTMLCanvasElement {
  const cv = document.createElement('canvas')
  cv.width = cv.height = size
  const c = cv.getContext('2d')!
  const m = size / 2
  const R = m / 1.6
  const g = c.createRadialGradient(m, m, R * 0.95, m, m, m)
  g.addColorStop(0, 'rgba(255,255,255,0)')
  g.addColorStop(0.06, 'rgba(255,255,255,0.7)')
  g.addColorStop(0.16, 'rgba(255,255,255,0.22)')
  g.addColorStop(0.32, 'rgba(255,255,255,0.05)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  c.fillStyle = g
  c.fillRect(0, 0, size, size)
  return cv
}

/** Background: deep navy with a few huge, very soft out-of-focus cells for depth. */
export function bakeBackdrop(size = 1024): HTMLCanvasElement {
  const cv = document.createElement('canvas')
  cv.width = cv.height = size
  const c = cv.getContext('2d')!
  const g = c.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size * 0.72)
  g.addColorStop(0, '#1a1342'); g.addColorStop(0.55, '#110c30'); g.addColorStop(1, '#07061a')
  c.fillStyle = g; c.fillRect(0, 0, size, size)
  // faint nebula clouds
  const blobs: [number, number, number, string][] = [
    [0.12, 0.2, 0.3, '110,80,220'], [0.88, 0.8, 0.34, '70,110,230'], [0.8, 0.1, 0.18, '150,70,200'],
    [0.18, 0.88, 0.22, '60,120,200'], [0.55, 0.5, 0.45, '80,60,180'],
  ]
  for (const [x, y, r, col] of blobs) {
    const b = c.createRadialGradient(x * size, y * size, 0, x * size, y * size, r * size)
    b.addColorStop(0, `rgba(${col},0.12)`); b.addColorStop(0.6, `rgba(${col},0.05)`); b.addColorStop(1, `rgba(${col},0)`)
    c.fillStyle = b; c.fillRect(0, 0, size, size)
  }
  // out-of-focus distant motes: soft rings
  let s = 41
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647)
  for (let i = 0; i < 26; i++) {
    const x = rnd() * size, y = rnd() * size, r = 6 + rnd() * rnd() * 46
    const hue = rnd() < 0.7 ? '120,150,255' : '200,110,230'
    const b = c.createRadialGradient(x, y, r * 0.55, x, y, r * 1.25)
    b.addColorStop(0, `rgba(${hue},0.02)`); b.addColorStop(0.55, `rgba(${hue},${0.07 + rnd() * 0.06})`); b.addColorStop(1, `rgba(${hue},0)`)
    c.fillStyle = b; c.beginPath(); c.arc(x, y, r * 1.25, 0, Math.PI * 2); c.fill()
  }
  return cv
}
