// Lineage map: the colony's whole family tree, opened from a small icon on the Specimen tab.
// Every division is a fork. Living specimens are orbs in their own colors (size by mass);
// specimens that divided are small dots; dissipated ones are hollow. The selected specimen's
// line of descent is lit in gold. Tap a living specimen to study it.
// Built to carry traits later: a trait can mark its node here once mutations exist.
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { X } from 'lucide-react'
import type { ChainNode } from './chain'
import { nameOf } from './names'
import { t } from './reveal'

const COL = 30 // px between neighbouring leaves, at the smallest
const ROW = 56 // px between generations, at the smallest
const GROW = 2.6 // a small colony spreads out to fill the panel, up to this much wider spacing
const PAD = 28

type Colors = { dark: string; light: string; core: string; rim: string }

export function LineageMap({ nodes, selected, colorsOf, onPick, onClose }: {
  nodes: ChainNode[]
  selected: number
  colorsOf: (id: number) => Colors | undefined
  onPick: (id: number) => void
  onClose: () => void
}) {
  const scroller = useRef<HTMLDivElement>(null)
  // the panel's size, so a small tree can spread out to fill it
  const [box, setBox] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const layout = useMemo(() => {
    const kids = new Map<number, number[]>()
    for (const n of nodes) {
      if (!n || n.id === 0) continue
      const list = kids.get(n.parent) ?? []
      list.push(n.id)
      kids.set(n.parent, list)
    }
    // the selected specimen's line of descent
    const path = new Set<number>()
    for (let n: ChainNode | undefined = nodes[selected]; n; n = n.id === 0 ? undefined : nodes[n.parent]) path.add(n.id)
    // tidy tree: leaves left to right in birth order, a parent centered over its children
    const leaves = nodes.filter(n => n && !n.split).length || 1
    const depthMax = nodes.reduce((a, n) => (n ? Math.max(a, n.depth) : a), 0)
    const col = box.w ? Math.min(COL * GROW, Math.max(COL, (box.w - PAD * 2) / Math.max(1, leaves - 1))) : COL
    const row = box.h ? Math.min(ROW * GROW, Math.max(ROW, (box.h - PAD * 2) / Math.max(1, depthMax))) : ROW
    const pos = new Map<number, { x: number; y: number }>()
    let leaf = 0, maxDepth = 0
    const place = (id: number, depth: number): number => {
      maxDepth = Math.max(maxDepth, depth)
      const ch = (kids.get(id) ?? []).sort((a, b) => a - b)
      const x = ch.length ? ch.map(c => place(c, depth + 1)).reduce((a, b) => a + b, 0) / ch.length : leaf++ * col
      pos.set(id, { x: x + PAD, y: depth * row + PAD })
      return x
    }
    if (nodes[0]) place(0, 0)
    const max = nodes.reduce((a, n) => (n && !n.split && n.energy > a ? n.energy : a), 1n)
    const grow = Math.min(col / COL, row / ROW)
    return { kids, path, pos, w: Math.max(1, leaf - 1) * col + PAD * 2, h: maxDepth * row + PAD * 2, max, grow }
  }, [nodes, selected, box])

  // open centered on the selected specimen
  useEffect(() => {
    const p = layout.pos.get(selected), el = scroller.current
    if (!p || !el) return
    el.scrollLeft = p.x - el.clientWidth / 2
    el.scrollTop = p.y - el.clientHeight / 2
  }, [layout, selected])

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [onClose])

  const { kids, path, pos, w, h, max, grow } = layout
  const k = Math.min(1.8, Math.sqrt(grow)) // orbs grow a little with the spacing
  const lines: ReactElement[] = []
  const dots: ReactElement[] = []
  for (const [parent, ch] of kids) {
    const a = pos.get(parent)
    if (!a) continue
    for (const c of ch) {
      const b = pos.get(c)
      if (!b) continue
      const lit = path.has(parent) && path.has(c)
      const my = (a.y + b.y) / 2
      lines.push(<path key={`l${c}`} d={`M${a.x},${a.y} C${a.x},${my} ${b.x},${my} ${b.x},${b.y}`} className={lit ? 'lin lit' : 'lin'} />)
    }
  }
  for (const n of nodes) {
    if (!n) continue
    const p = pos.get(n.id)
    if (!p) continue
    const live = !n.split && !n.gone
    const sel = n.id === selected
    if (live) {
      const c = colorsOf(n.id)
      const r = (5 + 7 * Math.sqrt(Number(n.energy) / Number(max))) * k
      const fill = `url(#g${n.id})`
      dots.push(
        <g key={n.id} className={sel ? 'lnode live sel' : 'lnode live'} onClick={() => onPick(n.id)} role="button" aria-label={nameOf(n.id)}>
          <defs>
            <radialGradient id={`g${n.id}`}>
              <stop offset="0%" stopColor={c?.core ?? '#ccc'} />
              <stop offset="35%" stopColor={c?.light ?? '#888'} />
              <stop offset="75%" stopColor={c?.dark ?? '#333'} />
              <stop offset="100%" stopColor={c?.rim ?? '#777'} />
            </radialGradient>
          </defs>
          <circle cx={p.x} cy={p.y} r={Math.max(14, r + 4)} className="hit" />
          {sel && <circle cx={p.x} cy={p.y} r={r + 5} className="halo" />}
          <circle cx={p.x} cy={p.y} r={r} fill={fill} style={{ filter: `drop-shadow(0 0 4px ${c?.rim ?? '#777'})` }} />
          <title>{nameOf(n.id)}</title>
        </g>,
      )
    } else {
      dots.push(
        <g key={n.id} className={path.has(n.id) ? 'lnode past lit' : 'lnode past'}>
          <circle cx={p.x} cy={p.y} r={(n.gone ? 3.5 : 3) * k} className={n.gone ? 'gone' : 'div'} />
          <title>{nameOf(n.id)}</title>
        </g>,
      )
    }
  }

  return (
    <div className="lineage" role="dialog" aria-label={t('cell.lineage')} onClick={onClose}>
      <div className="lineage-panel membrane" onClick={e => e.stopPropagation()}>
        <div className="lineage-head">
          <span className="lineage-title">{t('cell.lineage')}</span>
          <span className="lineage-name">{nameOf(selected)}</span>
          <button className="close cell-quiet" aria-label="Close" onClick={onClose}><X size={16} strokeWidth={2.5} /></button>
        </div>
        <div className="lineage-scroll" ref={scroller}>
          <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
            <g>{lines}</g>
            <g>{dots}</g>
          </svg>
        </div>
      </div>
    </div>
  )
}

/** The small icon that opens the map: a tiny fork. */
export function LineageIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" className="lineage-icon">
      <path d="M9 3 C9 8, 4 8, 4 14 M9 3 C9 8, 14 8, 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="9" cy="3" r="1.8" fill="currentColor" />
      <circle cx="4" cy="14.5" r="2.2" fill="currentColor" />
      <circle cx="14" cy="14.5" r="2.2" fill="currentColor" opacity="0.55" />
    </svg>
  )
}
