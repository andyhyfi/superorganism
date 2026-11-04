// Deep mode: the menu layer over the field. A side panel on desktop, a bottom sheet on phones.
// Four tabs: Node (the selected node), Network (the whole tree), Yours (every claim you hold),
// Feed (live events). Placeholder look; structure and controls only, until the design lands.
import { useState } from 'react'
import type { Address } from 'viem'
import type { ChainNode, NetEvent } from './chain'
import { fmtPct, fmtUsd, short } from './format'

export type Tab = 'node' | 'network' | 'yours' | 'feed'
export type Sheet = 'peek' | 'half' | 'full'

export type SelectedInfo = { id: number; total: bigint; claim: bigint; roll: bigint; split: bigint }

type Props = {
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
  { id: 'feed', label: 'Feed' },
]

export function Deep(p: Props) {
  const cls = p.narrow ? `deep sheet ${p.sheet}` : 'deep side'
  return (
    <aside className={cls} aria-label="Deep mode">
      {p.narrow && (
        <button
          className="grabber"
          aria-label="Resize panel"
          onClick={() => p.setSheet(p.sheet === 'peek' ? 'half' : p.sheet === 'half' ? 'full' : 'peek')}
        />
      )}
      <nav className="tabs" role="tablist">
        {TABS.map(t => (
          <button
            key={t.id}
            role="tab"
            aria-selected={p.tab === t.id}
            className={p.tab === t.id ? 'on' : ''}
            onClick={() => { p.setTab(t.id); if (p.narrow && p.sheet === 'peek') p.setSheet('half') }}
          >{t.label}</button>
        ))}
        <button className="close" aria-label="Back to Aquarium" onClick={p.onClose}>×</button>
      </nav>
      <div className="body">
        {p.tab === 'node' && <NodeTab {...p} />}
        {p.tab === 'network' && <NetworkTab {...p} />}
        {p.tab === 'yours' && <YoursTab {...p} />}
        {p.tab === 'feed' && <FeedTab {...p} />}
      </div>
    </aside>
  )
}

// --------------------------------------------------------------------- node

function NodeTab(p: Props) {
  const s = p.selected
  if (!s) return <Empty text="Tap a node to inspect it." />
  const node = p.nodes[s.id]
  const lineage: number[] = []
  for (let n = node; n && n.id !== 0; n = p.nodes[n.parent]) lineage.unshift(n.id)
  lineage.unshift(0)
  const amountOk = Number(p.amount) >= 1
  return (
    <>
      <header className="title">
        <span>Node {s.id}</span>
        <button className="link" onClick={() => p.onFocus(s.id)}>Center</button>
      </header>
      <dl className="kv">
        <dt>Holds</dt><dd>{fmtUsd(s.total)} USDC</dd>
        <dt>Generation</dt><dd>{node?.depth ?? 0}</dd>
        <dt>Roll chance</dt><dd>{fmtPct(s.roll)}</dd>
        <dt>Split chance</dt><dd>{fmtPct(s.split)}</dd>
        <dt>Split odds</dt><dd>1 in {p.odds.toString()}</dd>
        <dt>Fee</dt><dd>{((node?.traits.feePpm ?? 0) / 1e4).toFixed(4)}%</dd>
        <dt>Your claim</dt><dd className="gold">{fmtUsd(s.claim)} USDC</dd>
      </dl>
      <div className="lineage" aria-label="Lineage">
        {lineage.map((id, i) => (
          <span key={id}>
            {i > 0 && <span className="sep">›</span>}
            <button className={id === s.id ? 'crumb on' : 'crumb'} onClick={() => id !== s.id && !p.nodes[id]?.split && p.onSelect(id)} disabled={id !== s.id && !!p.nodes[id]?.split}>{id}</button>
          </span>
        ))}
      </div>
      <div className="field-input">
        <input value={p.amount} onChange={e => p.setAmount(e.target.value)} inputMode="decimal" aria-label="Amount in USDC" />
        <span className="unit">USDC</span>
      </div>
      <div className="actions">
        <button disabled={!!p.busy || !amountOk} onClick={p.onDeposit}>{p.busy === 'deposit' ? 'Depositing' : 'Deposit'}</button>
        <button className="ghost" disabled={!!p.busy || s.claim === 0n} onClick={p.onWithdraw}>{p.busy === 'withdraw' ? 'Withdrawing' : 'Withdraw claim'}</button>
      </div>
    </>
  )
}

// ------------------------------------------------------------------ network

type SortKey = 'total' | 'id' | 'depth'

function NetworkTab(p: Props) {
  const [sort, setSort] = useState<SortKey>('total')
  const live = p.nodes.filter(n => !n.split)
  const total = live.reduce((a, n) => a + n.total, 0n)
  const maxDepth = live.reduce((a, n) => Math.max(a, n.depth), 0)
  const rows = [...live].sort((a, b) =>
    sort === 'total' ? Number(b.total - a.total) : sort === 'id' ? a.id - b.id : b.depth - a.depth || a.id - b.id,
  )
  return (
    <>
      <div className="stats">
        <Stat k="Live nodes" v={String(live.length)} />
        <Stat k="Splits" v={String((p.nodes.length - 1) / 2)} />
        <Stat k="Held" v={`${fmtUsd(total)}`} />
        <Stat k="Generations" v={String(maxDepth)} />
        <Stat k="Fees owed" v={fmtUsd(p.fees)} />
      </div>
      <div className="seg" role="group" aria-label="Sort">
        {(['total', 'depth', 'id'] as SortKey[]).map(k => (
          <button key={k} className={sort === k ? 'on' : ''} onClick={() => setSort(k)}>{k === 'total' ? 'Largest' : k === 'depth' ? 'Youngest' : 'Oldest'}</button>
        ))}
      </div>
      <ul className="list">
        {rows.map(n => (
          <li key={n.id}>
            <button className={p.selected?.id === n.id ? 'row on' : 'row'} onClick={() => p.onSelect(n.id)}>
              <span className="id">#{n.id}</span>
              <span className="bar"><span style={{ width: `${total > 0n ? Math.max(2, Number((n.total * 1000n) / total) / 10) : 0}%` }} /></span>
              <span className="num">{fmtUsd(n.total)}</span>
              {(p.claims.get(n.id) ?? 0n) > 0n && <span className="mine" aria-label="You hold a claim" />}
            </button>
          </li>
        ))}
      </ul>
    </>
  )
}

// -------------------------------------------------------------------- yours

function YoursTab(p: Props) {
  const held = [...p.claims.entries()].filter(([, c]) => c > 0n).sort((a, b) => Number(b[1] - a[1]))
  const sum = held.reduce((a, [, c]) => a + c, 0n)
  if (!held.length) return <Empty text="You hold no claims. Deposit into a node to start." />
  return (
    <>
      <div className="stats">
        <Stat k="Claims" v={String(held.length)} />
        <Stat k="Total" v={fmtUsd(sum)} gold />
      </div>
      <ul className="list">
        {held.map(([id, c]) => (
          <li key={id}>
            <button className={p.selected?.id === id ? 'row on' : 'row'} onClick={() => p.onSelect(id)}>
              <span className="id">#{id}</span>
              <span className="grow">gen {p.nodes[id]?.depth ?? 0}</span>
              <span className="num gold">{fmtUsd(c)}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="actions">
        <button disabled={!!p.busy} onClick={p.onWithdrawAll}>
          {p.busy === 'withdrawAll' ? 'Withdrawing' : `Withdraw all · ${held.length} node${held.length > 1 ? 's' : ''}`}
        </button>
      </div>
      {held.length > 50 && <p className="note">Over 50 nodes: sent as {Math.ceil(held.length / 50)} transactions.</p>}
    </>
  )
}

// --------------------------------------------------------------------- feed

function FeedTab(p: Props) {
  const me = p.you.toLowerCase()
  if (!p.feed.length) return <Empty text="Waiting for activity." />
  return (
    <ul className="list feed">
      {p.feed.slice(0, 80).map(e => (
        <li key={e.key}>
          <button className="row" onClick={() => p.onSelect(e.kind === 'split' ? e.c0 : e.node)}>
            <span className={`kind ${e.kind}`}>{e.kind === 'deposit' ? 'In' : e.kind === 'withdraw' ? 'Out' : 'Split'}</span>
            {e.kind === 'split' ? (
              <span className="grow">#{e.parent} → #{e.c0} #{e.c1}</span>
            ) : (
              <>
                <span className="grow">#{e.node} · {e.user.toLowerCase() === me ? <b className="gold">you</b> : short(e.user)}</span>
                <span className="num">{fmtUsd(e.amount)}</span>
              </>
            )}
          </button>
        </li>
      ))}
    </ul>
  )
}

// ------------------------------------------------------------------- shared

function Stat({ k, v, gold }: { k: string; v: string; gold?: boolean }) {
  return (
    <div className="stat">
      <span className="k">{k}</span>
      <span className={gold ? 'v gold' : 'v'}>{v}</span>
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return <p className="empty">{text}</p>
}
