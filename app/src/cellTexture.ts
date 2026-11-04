// The node's surface as a reusable texture, so buttons, pills, and panel edges share the cells'
// material: the same three-arm spiral, the same glowing specks, the same hue. Generated once and
// exposed as CSS variables (--cell-spiral, --cell-specks). Swap this file when the node look changes.

const HUE = 214 // matches the field's default node hue

function spiralSvg(): string {
  const arms = 3, turns = 1.6, steps = 90, R = 50
  let paths = ''
  for (let k = 0; k < arms; k++) {
    let d = ''
    for (let i = 0; i <= steps; i++) {
      const s = i / steps
      const rr = R * 0.96 * Math.pow(s, 0.8)
      const a = (k / arms) * Math.PI * 2 + s * turns * Math.PI * 2
      d += `${i ? 'L' : 'M'}${(50 + Math.cos(a) * rr).toFixed(2)} ${(50 + Math.sin(a) * rr).toFixed(2)}`
    }
    paths += `<path d='${d}'/>`
  }
  return `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><g fill='none' stroke='hsl(${HUE - 20},90%,86%)' stroke-width='0.6' stroke-linecap='round' opacity='0.55'>${paths}</g></svg>`
}

function specksSvg(): string {
  // fixed seed: the same specks every load, like a real texture
  let seed = 7
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  let dots = ''
  for (let i = 0; i < 26; i++) {
    const x = rnd() * 200, y = rnd() * 100, r = 0.5 + rnd() * 1.3
    const gold = i % 9 === 4
    const c = gold ? 'hsl(42,100%,72%)' : `hsl(${HUE - 25},100%,90%)`
    dots += `<circle cx='${x.toFixed(1)}' cy='${y.toFixed(1)}' r='${(r * 2.4).toFixed(2)}' fill='url(#g${gold ? 1 : 0})'/>`
    dots += `<circle cx='${x.toFixed(1)}' cy='${y.toFixed(1)}' r='${(r * 0.5).toFixed(2)}' fill='${c}'/>`
  }
  const grad = (id: number, c: string) =>
    `<radialGradient id='g${id}'><stop offset='0' stop-color='${c}' stop-opacity='0.55'/><stop offset='1' stop-color='${c}' stop-opacity='0'/></radialGradient>`
  return `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 100'><defs>${grad(0, `hsl(${HUE - 25},100%,88%)`)}${grad(1, 'hsl(42,100%,72%)')}</defs>${dots}</svg>`
}

const url = (svg: string) => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`

export function installCellTexture() {
  const root = document.documentElement.style
  root.setProperty('--cell-hue', String(HUE))
  root.setProperty('--cell-spiral', url(spiralSvg()))
  root.setProperty('--cell-specks', url(specksSvg()))
}
