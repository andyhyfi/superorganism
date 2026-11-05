// The four Deep tabs. Words come from reveal.ts (t), and every optional section asks shown()
// first, so what a player sees can be gated by holdings, deposits, or mutations.
import { useState, type ReactNode } from 'react'
import { ArrowDownLeft, ArrowUpRight, ChevronRight, GitFork, Info, Spline, X } from 'lucide-react'
import type { DeepProps } from './Deep'
import { cleanAmount, fmtPct, fmtUsd, fromUnits, short, toUnits } from './format'
import { shown, t, type Ctx, type InfoId } from './reveal'
import { nameOf } from './names'
import { Rolling } from './Rolling'

const usdNum = (x: bigint) => Number(x) / 1e6

/** What the player has done, for reveal rules. */
export function playerCtx(p: DeepProps, heldHere = 0n): Ctx {
  const me = p.you.toLowerCase()
  const heldTotal = [...p.claims.values()].reduce((a, c) => a + c, 0n)
  const deposits = p.feed.filter(e => e.kind === 'deposit' && e.user.toLowerCase() === me).length
  return { heldHere: usdNum(heldHere), heldTotal: usdNum(heldTotal), deposits, deposited: usdNum(p.netDeposited), traits: [] }
}

/** Renders children only when the rule for `id` passes. */
function Gate({ id, c, children }: { id: InfoId; c: Ctx; children: ReactNode }) {
  return shown(id, c) ? <>{children}</> : null
}

/** Press animation: a pulse outward, like a deposit landing in a cell. */
const pulse = (e: React.MouseEvent<HTMLButtonElement>) => {
  const b = e.currentTarget
  b.classList.remove('pulse'); void b.offsetWidth; b.classList.add('pulse')
}

// --------------------------------------------------------------------- node

export function NodeTab(p: DeepProps) {
  const s = p.selected
  if (!s) return <Empty />
  const c = playerCtx(p, s.claim)
  const node = p.nodes[s.id]
  const lineage: number[] = []
  for (let n = node; n && n.id !== 0; n = p.nodes[n.parent]) lineage.unshift(n.id)
  lineage.unshift(0)
  const [side, setSide] = useState<'deposit' | 'withdraw'>('deposit')
  const out = side === 'withdraw'
  // deposits: at most the wallet, the per-deposit limit, and the room left under the per-user limit
  const room = p.limits.maxPerUser > p.heldNet ? p.limits.maxPerUser - p.heldNet : 0n
  const capIn = [p.wallet, p.limits.maxDeposit || p.wallet, p.limits.maxPerUser ? room : p.wallet].reduce((a, b) => (b < a ? b : a))
  const limit = out ? s.claim : capIn
  const units = toUnits(p.amount)
  const tooSmall = units > 0n && units < 1_000_000n && !(out && units === s.claim)
  const tooBig = units > limit
  const overReason = out ? t('act.overClaim') : units > p.wallet ? t('act.overWallet') : p.limits.maxDeposit && units > p.limits.maxDeposit ? t('act.overDeposit') : t('act.overUser')
  const reason = out && s.claim === 0n ? t('act.nothingHere') : tooSmall ? t('act.belowMin') : tooBig ? overReason : null
  const loansHere = p.links.filter(l => l.holder === s.id || l.lender === s.id)
  const now = Date.now() / 1000
  const amountOk = units > 0n && !tooSmall && !tooBig
  // +10 / +50 / +100 add to what is there; capped at what you can move
  const add = (v: number) => {
    const next = units + BigInt(v) * 1_000_000n
    p.setAmount(fromUnits(next > limit ? limit : next))
  }

  return (
    <>
      <div className="hero">
        <div className="cell-name">{nameOf(s.id)}</div>
        <div className="label">
          <span>{t('cell.balance')}</span>
          <button className="text-btn" onClick={() => p.onFocus(s.id)}>{t('cell.observe')}</button>
        </div>
        <div className="big"><Rolling value={s.energy} /></div>
        {/* Your part of this node, graphic only: gold = yours, dark = everyone else's, a small
            slash where they meet. Always the same height. */}
        <ShareBar total={s.total} yours={s.claim} />
      </div>

      <div className="segmented side" role="tablist">
        {(['deposit', 'withdraw'] as const).map(k => (
          <button key={k} role="tab" aria-selected={side === k} onClick={() => { setSide(k); p.setAmount('') }}>{t(k === 'deposit' ? 'act.deposit' : 'act.withdraw')}</button>
        ))}
      </div>
      <div className="amount membrane">
        <input value={p.amount} onChange={e => p.setAmount(cleanAmount(e.target.value))} inputMode="decimal" aria-label={t('act.amount')} placeholder="0" />
        <span className="unit">USDC</span>
        {units > 0n && <button className="clear" aria-label={t('act.clear')} onClick={() => p.setAmount('')}><X size={14} strokeWidth={2.5} /></button>}
      </div>
      <div className="quick">
        {[10, 50, 100].map(v => <button key={v} className="cell-quiet" disabled={units >= limit} onClick={() => add(v)}>+{v}</button>)}
        <button className="cell-quiet" disabled={limit === 0n} aria-pressed={units === limit && limit > 0n} onClick={() => p.setAmount(fromUnits(limit))}>{t('act.max')}</button>
      </div>
      <div className="buttons">
        {/* Messages live inside the button (fixed height), so the menu never changes size. */}
        {out ? (
          <button className={`btn cell-btn ${reason ? 'reason' : ''}`} disabled={!!p.busy || !amountOk} onClick={e => { pulse(e); p.onWithdraw(units) }}>
            {p.busy === 'withdraw' ? t('act.withdrawing') : reason ?? (units > 0n ? `${t('act.withdraw')} ${fmtUsd(units)}` : t('act.withdraw'))}
          </button>
        ) : (
          <button className={`btn cell-btn ${reason ? 'reason' : ''}`} disabled={!!p.busy || !amountOk} onClick={e => { pulse(e); p.onDeposit() }}>
            {p.busy === 'deposit' ? t('act.depositing') : reason ?? (units > 0n ? `${t('act.deposit')} ${fmtUsd(units)}` : t('act.deposit'))}
          </button>
        )}
      </div>

      <Gate id="cell.divideChance" c={c}>
        <div className="section-title">{t('cell.divideChance')}</div>
        <div className="group membrane">
          <Row k={t('cell.divideChance')} v={fmtPct(s.split)} />
          <Gate id="cell.fillCheck" c={c}><Row k={t('cell.fillCheck')} v={fmtPct(s.roll)} /></Gate>
          <Gate id="cell.divideOdds" c={c}><Row k={t('cell.divideOdds')} v={`1 in ${p.odds}`} /></Gate>
        </div>
        <Gate id="cell.divideExplainer" c={c}><p className="foot">{t('cell.divideExplainer')}</p></Gate>
      </Gate>

      {loansHere.length > 0 && (
        <>
          <div className="section-title">{t('cell.loans')}</div>
          <div className="group membrane">
            {loansHere.map(l => {
              const lending = l.lender === s.id
              const other = lending ? l.holder : l.lender
              const mins = Math.max(0, Math.ceil((l.due - now) / 60))
              return (
                <button key={`${l.loanId}:${l.holder}`} className="cell" onClick={() => p.onSelect(other)}>
                  <Orb colors={p.colorsOf(other)} />
                  <span className="k">
                    {lending ? t('cell.lentTo') : t('cell.borrowedFrom')} {nameOf(other)}
                    <span className="sub">{t('cell.returnsIn')} {mins} min</span>
                  </span>
                  <span className={lending ? 'v' : 'v strong'}>{lending ? '−' : '+'}{fmtUsd(l.amount)}</span>
                </button>
              )
            })}
          </div>
        </>
      )}

      <div className="section-title">&nbsp;</div>
      <div className="group membrane">
        <Row k={t('cell.deposits')} v={`${fmtUsd(s.total)} USDC`} />
        <Row k={t('cell.fee')} v={`${((node?.traits.feePpm ?? 0) / 1e4).toFixed(4)}%`} />
        <Row k={t('cell.minimum')} v="1" />
        {p.limits.maxDeposit > 0n && <Row k={t('cell.maximum')} v={fmtUsd(p.limits.maxDeposit)} />}
        {p.limits.eventFee > 0n && <Row k={t('cell.eventFee')} v={fmtUsd(p.limits.eventFee)} hint={t('cell.eventFeeHint')} />}
        <Gate id="cell.generation" c={c}><Row k={t('cell.generation')} v={String(node?.depth ?? 0)} /></Gate>
      </div>

      <Gate id="cell.lineage" c={c}>
        <div className="section-title">{t('cell.lineage')}</div>
        <div className="group membrane">
          <div className="chips">
            {lineage.map((id, i) => (
              <span key={id} style={{ display: 'contents' }}>
                {i > 0 && <ChevronRight size={14} className="arrow" />}
                <span className="chip cell-quiet" aria-current={id === s.id}>{nameOf(id)}</span>
              </span>
            ))}
          </div>
        </div>
        <p className="foot">{t('cell.lineageExplainer')}</p>
      </Gate>
    </>
  )
}

// ------------------------------------------------------------------ network

type SortKey = 'total' | 'depth' | 'id'

export function NetworkTab(p: DeepProps) {
  const [sort, setSort] = useState<SortKey>('total')
  const c = playerCtx(p)
  const live = p.nodes.filter(n => !n.split && !n.gone)
  const total = live.reduce((a, n) => a + n.total, 0n)
  const maxDepth = live.reduce((a, n) => Math.max(a, n.depth), 0)
  const max = live.reduce((a, n) => (n.total > a ? n.total : a), 1n)
  const rows = [...live].sort((a, b) =>
    sort === 'total' ? Number(b.total - a.total) : sort === 'id' ? a.id - b.id : b.depth - a.depth || a.id - b.id,
  )
  const meta = [
    `${live.length} ${t('net.counts')}`,
    shown('net.splits', c) && `${(p.nodes.length - 1) / 2} ${t('net.splits')}`,
    shown('net.generations', c) && `${maxDepth} ${t('net.generations')}`,
  ].filter(Boolean).join(' · ')
  return (
    <>
      <div className="hero">
        <div className="label"><span>{t('net.held')}</span></div>
        <div className="big"><Rolling value={total} /><small>USDC</small></div>
        <div className="meta">{meta}</div>
      </div>

      <Gate id="net.sort" c={c}>
        <div className="segmented membrane" role="tablist" style={{ marginBottom: 12 }}>
          {(['total', 'depth', 'id'] as SortKey[]).map(k => (
            <button key={k} role="tab" aria-selected={sort === k} onClick={() => setSort(k)}>
              {k === 'total' ? t('sort.mass') : k === 'depth' ? t('sort.youngest') : t('sort.eldest')}
            </button>
          ))}
        </div>
      </Gate>

      <div className="group membrane">
        {rows.map(n => (
          <button key={n.id} className="cell" onClick={() => p.onSelect(n.id)}>
            <Orb colors={p.colorsOf(n.id)} size={16} />
            <span className="name">{nameOf(n.id)}</span>
            <span className="meter"><span style={{ width: `${Math.max(3, Number((n.total * 100n) / max))}%` }} /></span>
            <span className="v num" style={{ width: 84, textAlign: 'right' }}>{fmtUsd(n.total)}</span>
            {(p.claims.get(n.id) ?? 0n) > 0n ? <span className="mark" /> : <span style={{ width: 8 }} />}
          </button>
        ))}
      </div>

      <Gate id="net.fees" c={c}>
        <div className="section-title">&nbsp;</div>
        <div className="group membrane"><Row k={t('net.fees')} v={`${fmtUsd(p.fees)} USDC`} /></div>
      </Gate>
    </>
  )
}

// -------------------------------------------------------------------- yours

export function YoursTab(p: DeepProps) {
  const held = [...p.claims.entries()].filter(([, c]) => c > 0n).sort((a, b) => Number(b[1] - a[1]))
  const sum = held.reduce((a, [, c]) => a + c, 0n)
  const me = p.you.toLowerCase()
  const mine = p.feed.filter(e => (e.kind === 'deposit' || e.kind === 'withdraw') && e.user.toLowerCase() === me).slice(0, 80)
  return (
    <>
      <div className="hero">
        <div className="label"><span>{t('you.balance')}</span></div>
        <div className="big"><Rolling value={sum} /><small>USDC</small></div>
        <div className="meta">{fmtUsd(p.wallet)} USDC {t('you.wallet')}</div>
      </div>
      {!held.length && !mine.length ? (
        <Empty title={t('you.empty')} text={t('you.emptyHint')} />
      ) : !held.length ? null : (
        <>
          <div className="group membrane">
            {held.map(([id, c]) => (
              <button key={id} className="cell" onClick={() => p.onSelect(id)}>
                <Orb id={id} colors={p.colorsOf(id)} />
                <span className="k name">{nameOf(id)}</span>
                <span className="v strong gold">{fmtUsd(c)}</span>
                <ChevronRight size={16} className="chev" />
              </button>
            ))}
          </div>
          <div className="buttons">
            <button className="btn cell-btn" disabled={!!p.busy} onClick={e => { pulse(e); p.onWithdrawAll() }}>
              {p.busy === 'withdrawAll' ? t('act.withdrawing') : t('act.withdrawAll')}
            </button>
          </div>
        </>
      )}
      {mine.length > 0 && (
        <>
          <div className="section-title">{t('you.activity')}</div>
          <FeedList p={p} rows={mine} />
        </>
      )}
    </>
  )
}

/** A small orb in a cell's own colors (core, body, rim), for lists. */
export function Orb({ colors, size = 22 }: { id?: number; colors?: { dark: string; light: string; core: string; rim: string }; size?: number }) {
  const c = colors ?? { dark: '#222', light: '#555', core: '#999', rim: '#777' }
  return (
    <span className="orb" style={{
      width: size, height: size,
      background: `radial-gradient(circle at 50% 50%, ${c.core} 0%, ${c.light} 32%, ${c.dark} 70%, ${c.rim} 96%)`,
      boxShadow: `0 0 8px ${c.rim}88`,
    }} />
  )
}

// --------------------------------------------------------------------- feed

export function FeedTab(p: DeepProps) {
  const c = playerCtx(p)
  const me = p.you.toLowerCase()
  const see = {
    deposit: shown('net.seeDeposits', c),
    withdraw: shown('net.seeWithdrawals', c),
    split: shown('net.seeSplits', c),
    loan: shown('net.seeLoans', c),
    repay: shown('net.seeLoans', c),
  }
  // other players only: your own rows live on the Yours tab
  const rows = p.feed
    .filter(e => see[e.kind])
    .filter(e => !('user' in e) || e.user.toLowerCase() !== me)
    .slice(0, 80)
  if (!Object.values(see).some(Boolean)) return <Empty />
  if (!rows.length) return <Empty title={t('feed.empty')} text="" />
  return <FeedList p={p} rows={rows} />
}

/** One list of events; shared by the Activity tab (network) and the Yours tab (your own). */
function FeedList({ p, rows }: { p: DeepProps; rows: DeepProps['feed'] }) {
  const me = p.you.toLowerCase()
  return (
    <div className="group membrane" style={{ marginTop: 8 }}>
      {rows.map(e => {
        if (e.kind === 'loan' || e.kind === 'repay') {
          const to = e.kind === 'loan' ? e.borrower : e.lender
          return (
            <button key={e.key} className="cell" onClick={() => !p.nodes[to]?.split && p.onSelect(to)}>
              <span className="badge split"><Spline size={16} strokeWidth={2.25} /></span>
              <span className="k">{e.kind === 'loan' ? t('feed.loan') : t('feed.repay')}<span className="sub">{e.kind === 'loan' ? `${nameOf(e.lender)} → ${nameOf(e.borrower)}` : `→ ${nameOf(e.lender)}`}</span></span>
              {e.kind === 'loan' && <span className="v">{fmtUsd(e.amount)}</span>}
            </button>
          )
        }
        const target = e.kind === 'split' ? e.c0 : e.node
        const mine = e.kind !== 'split' && e.user.toLowerCase() === me
        return (
          <button key={e.key} className="cell" onClick={() => !p.nodes[target]?.split && p.onSelect(target)}>
            {e.kind === 'deposit' && <span className="badge in"><ArrowDownLeft size={16} strokeWidth={2.25} /></span>}
            {e.kind === 'withdraw' && <span className="badge out"><ArrowUpRight size={16} strokeWidth={2.25} /></span>}
            {e.kind === 'split' && <span className="badge split"><GitFork size={16} strokeWidth={2.25} /></span>}
            <span className="k">
              {e.kind === 'split' ? t('feed.split') : e.kind === 'deposit' ? t('feed.deposit') : t('feed.withdraw')}
              <span className="sub">{e.kind === 'split' ? `${nameOf(e.parent)} → ${nameOf(e.c0)}, ${nameOf(e.c1)}` : `${mine ? 'You' : short(e.user)} · ${nameOf(e.node)}`}</span>
            </span>
            {e.kind !== 'split' && <span className={mine ? 'v strong gold' : 'v'}>{e.kind === 'withdraw' ? '−' : '+'}{fmtUsd(e.amount)}</span>}
          </button>
        )
      })}
    </div>
  )
}

// ------------------------------------------------------------------- shared

/** A label and a value. With `hint`: hovering (mouse) shows it, and a tap (touch) shows it in
 *  place of the label for a few seconds, so the row never changes size. */
function Row({ k, v, hint }: { k: string; v: string; hint?: string }) {
  const [open, setOpen] = useState(false)
  if (!hint) {
    return (
      <div className="cell">
        <span className="k">{k}</span>
        <span className="v">{v}</span>
      </div>
    )
  }
  return (
    <div className="cell has-hint" title={hint} aria-description={hint} tabIndex={0}
      onClick={() => { setOpen(true); window.setTimeout(() => setOpen(false), 3500) }}>
      <span className="k">{open ? <span className="hint-text">{hint}</span> : <>{k}<Info size={13} strokeWidth={2.25} className="hint-mark" /></>}</span>
      <span className="v">{v}</span>
    </div>
  )
}

/** Everything deposited in a node, with your part lit. Fixed height: never shifts the menu. */
function ShareBar({ total, yours }: { total: bigint; yours: bigint }) {
  const pct = total > 0n ? Number((yours * 10_000n) / total) / 100 : 0
  const w = yours > 0n ? Math.max(1.5, Math.min(100, pct)) : 0
  return (
    <div className="share" role="img" aria-label={`${pct.toFixed(1)}%`}>
      <div className="share-track">
        <span className="share-fill" style={{ width: `${w}%` }} />
        {w > 0 && w < 100 && <span className="share-cut" style={{ left: `${w}%` }} />}
      </div>
    </div>
  )
}

/** An uncolored node: a soft glowing orb with a thin rim and a faint core, like the cells. */
function NodeGlyph() {
  return (
    <span className="node-glyph" aria-hidden="true">
      <span className="speck s1" /><span className="speck s2" />
    </span>
  )
}

function Empty({ title, text }: { title?: string; text?: string }) {
  return (
    <div className="empty">
      <NodeGlyph />
      {title && <div className="t">{title}</div>}
      {text && <div>{text}</div>}
    </div>
  )
}
