// The four Deep tabs. Each leads with one big number, then grouped inset lists.
import { useState } from 'react'
import { ArrowDownLeft, ArrowUpRight, ChevronRight, GitFork, Inbox } from 'lucide-react'
import type { DeepProps } from './Deep'
import { fmtPct, fmtUsd, short } from './format'

// --------------------------------------------------------------------- node

export function NodeTab(p: DeepProps) {
  const s = p.selected
  if (!s) return <Empty title="No node selected" text="Tap a cell in the network to see it here." />
  const node = p.nodes[s.id]
  const lineage: number[] = []
  for (let n = node; n && n.id !== 0; n = p.nodes[n.parent]) lineage.unshift(n.id)
  lineage.unshift(0)
  const amt = Number(p.amount)
  const amountOk = Number.isFinite(amt) && amt >= 1 && BigInt(Math.round(amt * 1e6)) <= p.wallet
  const set = (v: number) => p.setAmount(String(v))

  return (
    <>
      <div className="hero">
        <div className="label">
          <span>Node {s.id} balance</span>
          <button className="text-btn" onClick={() => p.onFocus(s.id)}>Show on map</button>
        </div>
        <div className="big">{fmtUsd(s.total)}<small>USDC</small></div>
        {s.claim > 0n && <div className="meta">You hold <span className="gold">{fmtUsd(s.claim)} USDC</span> here</div>}
      </div>

      <div className="amount">
        <input value={p.amount} onChange={e => p.setAmount(e.target.value.replace(/[^0-9.]/g, ''))} inputMode="decimal" aria-label="Amount" placeholder="0" />
        <span className="unit">USDC</span>
      </div>
      <div className="quick">
        {[10, 50, 100].map(v => <button key={v} aria-pressed={amt === v} onClick={() => set(v)}>{v}</button>)}
        <button aria-pressed={amt === Math.floor(Number(p.wallet) / 1e6)} onClick={() => set(Math.floor(Number(p.wallet) / 1e6))}>Max</button>
      </div>
      <div className="buttons">
        <button className="btn" disabled={!!p.busy || !amountOk} onClick={p.onDeposit}>
          {p.busy === 'deposit' ? 'Depositing…' : 'Deposit'}
        </button>
        {s.claim > 0n && (
          <button className="btn secondary" disabled={!!p.busy} onClick={p.onWithdraw}>
            {p.busy === 'withdraw' ? 'Withdrawing…' : `Withdraw ${fmtUsd(s.claim)}`}
          </button>
        )}
      </div>

      <div className="section-title">Chance this cell divides</div>
      <div className="group">
        <Cell k="On your next deposit" v={fmtPct(s.split)} />
        <Cell k="Fill check passes" v={fmtPct(s.roll)} />
        <Cell k="Then divides" v={`1 in ${p.odds}`} />
      </div>
      <p className="foot">Fuller cells are more likely to divide. When one does, every balance in it is split evenly between the two new cells.</p>

      <div className="section-title">Details</div>
      <div className="group">
        <Cell k="Generation" v={String(node?.depth ?? 0)} />
        <Cell k="Fee" v={`${((node?.traits.feePpm ?? 0) / 1e4).toFixed(4)}%`} />
        <Cell k="Minimum" v="1 USDC" />
      </div>

      <div className="section-title">Lineage</div>
      <div className="group">
        <div className="chips">
          {lineage.map((id, i) => {
            const here = id === s.id
            return (
              <span key={id} style={{ display: 'contents' }}>
                {i > 0 && <ChevronRight size={14} className="arrow" />}
                <span className="chip" aria-current={here} style={{ display: 'inline-flex', alignItems: 'center' }}>
                  {id === 0 ? 'Origin' : `Node ${id}`}
                </span>
              </span>
            )
          })}
        </div>
      </div>
      <p className="foot">Each cell came from its parent dividing. Earlier generations no longer hold funds.</p>
    </>
  )
}

// ------------------------------------------------------------------ network

type SortKey = 'total' | 'depth' | 'id'

export function NetworkTab(p: DeepProps) {
  const [sort, setSort] = useState<SortKey>('total')
  const live = p.nodes.filter(n => !n.split)
  const total = live.reduce((a, n) => a + n.total, 0n)
  const maxDepth = live.reduce((a, n) => Math.max(a, n.depth), 0)
  const max = live.reduce((a, n) => (n.total > a ? n.total : a), 1n)
  const rows = [...live].sort((a, b) =>
    sort === 'total' ? Number(b.total - a.total) : sort === 'id' ? a.id - b.id : b.depth - a.depth || a.id - b.id,
  )
  return (
    <>
      <div className="hero">
        <div className="label"><span>Held across the network</span></div>
        <div className="big">{fmtUsd(total)}<small>USDC</small></div>
        <div className="meta">{live.length} cells · {(p.nodes.length - 1) / 2} splits · {maxDepth} generations</div>
      </div>

      <div className="segmented" role="tablist" style={{ marginBottom: 12 }}>
        {(['total', 'depth', 'id'] as SortKey[]).map(k => (
          <button key={k} role="tab" aria-selected={sort === k} onClick={() => setSort(k)}>
            {k === 'total' ? 'Largest' : k === 'depth' ? 'Newest' : 'Oldest'}
          </button>
        ))}
      </div>

      <div className="group">
        {rows.map(n => (
          <button key={n.id} className="cell" onClick={() => p.onSelect(n.id)}>
            <span style={{ width: 44 }} className="num">#{n.id}</span>
            <span className="meter"><span style={{ width: `${Math.max(3, Number((n.total * 100n) / max))}%` }} /></span>
            <span className="v num" style={{ width: 84, textAlign: 'right' }}>{fmtUsd(n.total)}</span>
            {(p.claims.get(n.id) ?? 0n) > 0n ? <span className="mark" aria-label="You hold funds here" /> : <span style={{ width: 8 }} />}
          </button>
        ))}
      </div>

      <div className="section-title">Protocol</div>
      <div className="group">
        <Cell k="Fees collected" v={`${fmtUsd(p.fees)} USDC`} />
      </div>
    </>
  )
}

// -------------------------------------------------------------------- yours

export function YoursTab(p: DeepProps) {
  const held = [...p.claims.entries()].filter(([, c]) => c > 0n).sort((a, b) => Number(b[1] - a[1]))
  const sum = held.reduce((a, [, c]) => a + c, 0n)
  return (
    <>
      <div className="hero">
        <div className="label"><span>Your balance in the network</span></div>
        <div className="big">{fmtUsd(sum)}<small>USDC</small></div>
        <div className="meta">{fmtUsd(p.wallet)} USDC in your wallet</div>
      </div>
      {!held.length ? (
        <Empty title="Nothing deposited yet" text="Tap a cell and deposit to join the network." />
      ) : (
        <>
          <div className="group">
            {held.map(([id, c]) => (
              <button key={id} className="cell" onClick={() => p.onSelect(id)}>
                <span className="k">Node {id}<span className="sub">Generation {p.nodes[id]?.depth ?? 0}</span></span>
                <span className="v strong gold">{fmtUsd(c)}</span>
                <ChevronRight size={16} className="chev" />
              </button>
            ))}
          </div>
          <div className="buttons">
            <button className="btn" disabled={!!p.busy} onClick={p.onWithdrawAll}>
              {p.busy === 'withdrawAll' ? 'Withdrawing…' : held.length > 1 ? `Withdraw all from ${held.length} nodes` : 'Withdraw all'}
            </button>
          </div>
          {held.length > 50 && <p className="foot">Sent as {Math.ceil(held.length / 50)} transactions.</p>}
        </>
      )}
    </>
  )
}

// --------------------------------------------------------------------- feed

export function FeedTab(p: DeepProps) {
  const me = p.you.toLowerCase()
  if (!p.feed.length) return <Empty title="Quiet for now" text="Deposits, withdrawals, and splits appear here live." />
  return (
    <div className="group" style={{ marginTop: 8 }}>
      {p.feed.slice(0, 80).map(e => {
        const target = e.kind === 'split' ? e.c0 : e.node
        const who = e.kind !== 'split' && e.user.toLowerCase() === me ? 'You' : e.kind !== 'split' ? short(e.user) : ''
        return (
          <button key={e.key} className="cell" onClick={() => !p.nodes[target]?.split && p.onSelect(target)}>
            {e.kind === 'deposit' && <span className="badge in"><ArrowDownLeft size={16} strokeWidth={2.25} /></span>}
            {e.kind === 'withdraw' && <span className="badge out"><ArrowUpRight size={16} strokeWidth={2.25} /></span>}
            {e.kind === 'split' && <span className="badge split"><GitFork size={16} strokeWidth={2.25} /></span>}
            <span className="k">
              {e.kind === 'split' ? `Node ${e.parent} split` : e.kind === 'deposit' ? 'Deposit' : 'Withdrawal'}
              <span className="sub">{e.kind === 'split' ? `Into ${e.c0} and ${e.c1}` : `${who} · node ${e.node}`}</span>
            </span>
            {e.kind !== 'split' && <span className={who === 'You' ? 'v strong gold' : 'v'}>{e.kind === 'withdraw' ? '−' : '+'}{fmtUsd(e.amount)}</span>}
          </button>
        )
      })}
    </div>
  )
}

// ------------------------------------------------------------------- shared

function Cell({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className="cell">
      <span className="k">{k}</span>
      <span className={strong ? 'v strong' : 'v'}>{v}</span>
    </div>
  )
}

function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty">
      <Inbox size={28} strokeWidth={1.75} style={{ color: 'var(--text-3)', marginBottom: 10 }} />
      <div className="t">{title}</div>
      <div>{text}</div>
    </div>
  )
}
