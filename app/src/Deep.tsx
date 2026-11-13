// Deep mode: the menu layer over the field. A side sheet on desktop, a bottom sheet on phones.
// iOS conventions throughout: segmented tabs, one hero number, grouped inset lists, full-width
// buttons, sentence case. Tabs live in Tabs.tsx.
import { X } from 'lucide-react'
import type { Address } from 'viem'
import type { ChainNode, LoanLink, NetEvent } from './chain'
import { NodeTab, NetworkTab, YoursTab, FeedTab } from './Tabs'
import { attachSheetDrag } from './sheetDrag'
import { useEffect, useRef, type ReactNode } from 'react'
import { t, networkActivityExists } from './reveal'
import './deep.css'
import './cell.css'

export type Tab = 'node' | 'network' | 'yours' | 'feed'
export type Sheet = 'peek' | 'half' | 'full'
export type SelectedInfo = {
  id: number; total: bigint; energy: bigint; lent: bigint; borrowed: bigint; claim: bigint; roll: bigint; split: bigint
}

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
  onWithdraw: (amount: bigint) => void
  onWithdrawAll: () => void
  onClose: () => void
  colorsOf: (id: number) => { dark: string; light: string; core: string; rim: string } | undefined
  links: LoanLink[]
  limits: { maxDeposit: bigint; maxPerUser: bigint; eventFee: bigint }
  heldNet: bigint
  netDeposited: bigint
  // play-money demo: no fees; extra game sections in each tab (placeholders until Andy's design)
  demo?: boolean
  nodeExtra?: (id: number) => ReactNode
  networkExtra?: ReactNode
  yoursExtra?: ReactNode
}

const TABS = ([
  { id: 'node', label: t('tab.node') },
  { id: 'network', label: t('tab.network') },
  { id: 'yours', label: t('tab.yours') },
  { id: 'feed', label: t('tab.activity') },
] as { id: Tab; label: string }[]).filter(x => x.id !== 'feed' || networkActivityExists()) // no network activity at all: no tab

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
    <aside ref={ref} className={p.narrow ? `deep membrane sheet ${p.sheet}` : 'deep membrane side'} aria-label={t('mode.study')}>
      {p.narrow && <div ref={grab} className="grabber" role="slider" aria-label="Drag to resize" aria-valuetext={p.sheet} />}
      <div className="head">
        <div className="segmented membrane" role="tablist">
          {TABS.map(x => (
            <button
              key={x.id}
              role="tab"
              aria-selected={p.tab === x.id}
              onClick={() => { p.setTab(x.id); if (p.narrow && p.sheet === 'peek') p.setSheet('half') }}
            >{x.label}</button>
          ))}
        </div>
        <button className="close cell-quiet" aria-label="Close" onClick={p.onClose}><X size={16} strokeWidth={2.5} /></button>
      </div>
      <div className="body">
        {p.tab === 'node' && <NodeTab {...p} />}
        {p.tab === 'network' && <NetworkTab {...p} />}
        {p.tab === 'yours' && <YoursTab {...p} />}
        {p.tab === 'feed' && networkActivityExists() && <FeedTab {...p} />}
      </div>
    </aside>
  )
}
