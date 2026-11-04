// Deep mode: the menu layer over the field. A side sheet on desktop, a bottom sheet on phones.
// iOS conventions throughout: segmented tabs, one hero number, grouped inset lists, full-width
// buttons, sentence case. Tabs live in Tabs.tsx.
import { X } from 'lucide-react'
import type { Address } from 'viem'
import type { ChainNode, NetEvent } from './chain'
import { NodeTab, NetworkTab, YoursTab, FeedTab } from './Tabs'
import { attachSheetDrag } from './sheetDrag'
import { useEffect, useRef } from 'react'
import './deep.css'

export type Tab = 'node' | 'network' | 'yours' | 'feed'
export type Sheet = 'peek' | 'half' | 'full'
export type SelectedInfo = { id: number; total: bigint; claim: bigint; roll: bigint; split: bigint }

export type DeepProps = {
  tab: Tab
  setTab: (t: Tab) => void
  sheet: Sheet
  setSheet: (s: Sheet) => void
  narrow: boolean
  nodes: ChainNode[]
  feed: NetEvent[]
  you: Address
  selected: SelectedInfo | null
  claims: Map<number, bigint>
  fees: bigint
  odds: bigint
  wallet: bigint
  busy: string | null
  amount: string
  setAmount: (s: string) => void
  onSelect: (id: number) => void
  onFocus: (id: number) => void
  onDeposit: () => void
  onWithdraw: () => void
  onWithdrawAll: () => void
  onClose: () => void
}

const TABS: { id: Tab; label: string }[] = [
  { id: 'node', label: 'Node' },
  { id: 'network', label: 'Network' },
  { id: 'yours', label: 'Yours' },
  { id: 'feed', label: 'Activity' },
]

export function Deep(p: DeepProps) {
  const ref = useRef<HTMLElement>(null)
  const grab = useRef<HTMLDivElement>(null)
  const sheetRef = useRef(p.sheet)
  sheetRef.current = p.sheet

  useEffect(() => {
    if (!p.narrow || !grab.current || !ref.current) return
    return attachSheetDrag(grab.current, ref.current, () => sheetRef.current, p.setSheet)
  }, [p.narrow, p.setSheet])

  return (
    <aside ref={ref} className={p.narrow ? `deep sheet ${p.sheet}` : 'deep side'} aria-label="Details">
      {p.narrow && <div ref={grab} className="grabber" role="slider" aria-label="Drag to resize" aria-valuetext={p.sheet} />}
      <div className="head">
        <div className="segmented" role="tablist">
          {TABS.map(t => (
            <button
              key={t.id}
              role="tab"
              aria-selected={p.tab === t.id}
              onClick={() => { p.setTab(t.id); if (p.narrow && p.sheet === 'peek') p.setSheet('half') }}
            >{t.label}</button>
          ))}
        </div>
        <button className="close" aria-label="Close" onClick={p.onClose}><X size={16} strokeWidth={2.5} /></button>
      </div>
      <div className="body">
        {p.tab === 'node' && <NodeTab {...p} />}
        {p.tab === 'network' && <NetworkTab {...p} />}
        {p.tab === 'yours' && <YoursTab {...p} />}
        {p.tab === 'feed' && <FeedTab {...p} />}
      </div>
    </aside>
  )
}
