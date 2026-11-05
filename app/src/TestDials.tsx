// LOCAL TEST CHAIN ONLY: two sliders for the split chance and the loan event chance, so Andy can
// watch splits and loans happen while tuning animations and UI. They set EvolutionDemo's dials;
// the production contract has none. Collapsed to a small button until opened.
import { useEffect, useState } from 'react'
import { SlidersHorizontal, X } from 'lucide-react'
import type { Dials } from './chain'

const pct = (ppm: number) => (ppm / 10_000).toFixed(ppm % 10_000 ? 1 : 0)

export function TestDials({ dials, onChange }: { dials: Dials; onChange: (d: Dials) => void }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(dials)
  useEffect(() => setDraft(dials), [dials])
  const commit = (d: Dials) => { setDraft(d); onChange(d) }

  if (!open) {
    return (
      <button className="dials-open glass membrane cell-quiet" aria-label="Test dials" onClick={() => setOpen(true)}>
        <SlidersHorizontal size={16} strokeWidth={2.25} />
      </button>
    )
  }
  const row = (label: string, key: keyof Dials, max: number, realText: string) => {
    const v = draft[key]
    const real = v === 0
    return (
      <label className="dial">
        <span className="dial-head">
          <span>{label}</span>
          <span className="num">{real ? realText : `${pct(key === 'eventPpm' && v === 1 ? 0 : v)}%`}</span>
        </span>
        <input
          type="range" min={0} max={max} step={key === 'splitPpm' ? 5_000 : 10_000} value={v}
          onChange={e => setDraft({ ...draft, [key]: Number(e.target.value) })}
          onPointerUp={e => commit({ ...draft, [key]: Number((e.target as HTMLInputElement).value) })}
          onKeyUp={e => commit({ ...draft, [key]: Number((e.target as HTMLInputElement).value) })}
        />
        <span className="dial-foot">
          <button className="text-btn" onClick={e => { e.preventDefault(); commit({ ...draft, [key]: 0 }) }}>Real rules</button>
          {key === 'eventPpm' && <button className="text-btn" onClick={e => { e.preventDefault(); commit({ ...draft, eventPpm: 1 }) }}>Off</button>}
        </span>
      </label>
    )
  }
  return (
    <div className="dials glass membrane" role="group" aria-label="Test dials">
      <div className="dials-title">
        <span>Test dials <span className="sub">local only</span></span>
        <button className="close cell-quiet" aria-label="Close" onClick={() => setOpen(false)}><X size={14} strokeWidth={2.5} /></button>
      </div>
      {row('Split chance per roll', 'splitPpm', 500_000, 'real curve')}
      {row('Loan event chance per deposit', 'eventPpm', 1_000_000, '15% (real)')}
    </div>
  )
}
