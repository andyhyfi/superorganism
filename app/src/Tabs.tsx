// The four Deep tabs. Words come from reveal.ts (t), and every optional section asks shown()
// first, so what a player sees can be gated by holdings, deposits, or mutations.
import { useState, type ReactNode } from 'react'
import { ArrowDownLeft, ArrowUpRight, ChevronRight, GitFork, Inbox, X } from 'lucide-react'
import type { DeepProps } from './Deep'
import { cleanAmount, fmtPct, fmtUsd, fromUnits, short, toUnits } from './format'
import { shown, t, type Ctx, type InfoId } from './reveal'

const usdNum = (x: bigint) => Number(x) / 1e6

/** What the player has done, for reveal rules. */
export function playerCtx(p: DeepProps, heldHere = 0n): Ctx {
  const me = p.you.toLowerCase()
  const heldTotal = [...p.claims.values()].reduce((a, c) => a + c, 0n)
  const deposits = p.feed.filter(e => e.kind === 'deposit' && e.user.toLowerCase() === me).length
  return { heldHere: usdNum(heldHere), heldTotal: usdNum(heldTotal), deposits, traits: [] }
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
  if (!s) return <Empty title={t('empty.noCell')} text={t('empty.noCellHint')} />
  const c = playerCtx(p, s.claim)
  const node = p.nodes[s.id]
  const lineage: number[] = []
  for (let n = node; n && n.id !== 0; n = p.nodes[n.parent]) lineage.unshift(n.id)
  lineage.unshift(0)
  const [side, setSide] = useState<'deposit' | 'withdraw'>('deposit')
  const out = side === 'withdraw' && s.claim > 0n
  const limit = out ? s.claim : p.wallet
  const units = toUnits(p.amount)
  const tooSmall = units > 0n && units < 1_000_000n && !(out && units === s.claim)
  const tooBig = units > limit
  const amountOk = units > 0n && !tooSmall && !tooBig
  // +10 / +50 / +100 add to what is there; capped at what you can move
  const add = (v: number) => {
    const next = units + BigInt(v) * 1_000_000n
    p.setAmount(fromUnits(next > limit ? limit : next))
  }

  return (
    <>
      <div className="hero">
        <div className="label">
          <span>{t('cell.balance')}</span>
          <button className="text-btn" onClick={() => p.onFocus(s.id)}>{t('cell.showOnMap')}</button>
        </div>
        <div className="big">{fmtUsd(s.total)}<small>USDC</small></div>
        <Gate id="cell.yourShare" c={c}>
          <div className="meta">{t('cell.yourShare')} <span className="gold">{fmtUsd(s.claim)}</span></div>
        </Gate>
      </div>

      {s.claim > 0n && (
        <div className="segmented side" role="tablist">
          {(['deposit', 'withdraw'] as const).map(k => (
            <button key={k} role="tab" aria-selected={side === k} onClick={() => { setSide(k); p.setAmount('') }}>{t(k === 'deposit' ? 'act.deposit' : 'act.withdraw')}</button>
          ))}
        </div>
      )}
      <div className="amount membrane">
        <input value={p.amount} onChange={e => p.setAmount(cleanAmount(e.target.value))} inputMode="decimal" aria-label={t('act.amount')} placeholder="0" />
        <span className="unit">USDC</span>
        {units > 0n && <button className="clear" aria-label={t('act.clear')} onClick={() => p.setAmount('')}><X size={14} strokeWidth={2.5} /></button>}
      </div>
      {(tooSmall || tooBig) && <p className="hint-err">{tooSmall ? t('act.belowMin') : out ? t('act.overClaim') : t('act.overWallet')}</p>}
      <div className="quick">
        {[10, 50, 100].map(v => <button key={v} className="cell-quiet" disabled={units >= limit} onClick={() => add(v)}>+{v}</button>)}
        <button className="cell-quiet" aria-pressed={units === limit && limit > 0n} onClick={() => p.setAmount(fromUnits(limit))}>{t('act.max')}</button>
      </div>
      <div className="buttons">
        {out ? (
          <button className="btn cell-btn" disabled={!!p.busy || !amountOk} onClick={e => { pulse(e); p.onWithdraw(units) }}>
            {p.busy === 'withdraw' ? t('act.withdrawing') : units > 0n ? `${t('act.withdraw')} ${fmtUsd(units)}` : t('act.withdraw')}
          </button>
        ) : (
          <button className="btn cell-btn" disabled={!!p.busy || !amountOk} onClick={e => { pulse(e); p.onDeposit() }}>
            {p.busy === 'deposit' ? t('act.depositing') : units > 0n ? `${t('act.deposit')} ${fmtUsd(units)}` : t('act.deposit')}
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

      <div className="section-title">&nbsp;</div>
      <div className="group membrane">
        <Gate id="cell.generation" c={c}><Row k={t('cell.generation')} v={String(node?.depth ?? 0)} /></Gate>
        <Row k={t('cell.fee')} v={`${((node?.traits.feePpm ?? 0) / 1e4).toFixed(4)}%`} />
        <Row k={t('cell.minimum')} v="1 USDC" />
      </div>

      <Gate id="cell.lineage" c={c}>
        <div className="section-title">{t('cell.lineage')}</div>
        <div className="group membrane">
          <div className="chips">
            {lineage.map((id, i) => (
              <span key={id} style={{ display: 'contents' }}>
                {i > 0 && <ChevronRight size={14} className="arrow" />}
                <span className="chip cell-quiet" aria-current={id === s.id}>{id}</span>
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
  const live = p.nodes.filter(n => !n.split)
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
        <div className="big">{fmtUsd(total)}<small>USDC</small></div>
        <div className="meta">{meta}</div>
      </div>

      <Gate id="net.sort" c={c}>
        <div className="segmented membrane" role="tablist" style={{ marginBottom: 12 }}>
          {(['total', 'depth', 'id'] as SortKey[]).map(k => (
            <button key={k} role="tab" aria-selected={sort === k} onClick={() => setSort(k)}>
              {k === 'total' ? 'Largest' : k === 'depth' ? 'Newest' : 'Oldest'}
            </button>
          ))}
        </div>
      </Gate>

      <div className="group membrane">
        {rows.map(n => (
          <button key={n.id} className="cell" onClick={() => p.onSelect(n.id)}>
            <span style={{ width: 44 }} className="num">{n.id}</span>
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
  return (
    <>
      <div className="hero">
        <div className="label"><span>{t('you.balance')}</span></div>
        <div className="big">{fmtUsd(sum)}<small>USDC</small></div>
        <div className="meta">{fmtUsd(p.wallet)} USDC {t('you.wallet')}</div>
      </div>
      {!held.length ? (
        <Empty title={t('you.empty')} text={t('you.emptyHint')} />
      ) : (
        <>
          <div className="group membrane">
            {held.map(([id, c]) => (
              <button key={id} className="cell" onClick={() => p.onSelect(id)}>
                <span className="k">{id}</span>
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
    </>
  )
}

// --------------------------------------------------------------------- feed

export function FeedTab(p: DeepProps) {
  const c = playerCtx(p)
  const me = p.you.toLowerCase()
  const others = shown('feed.others', c)
  const rows = p.feed.filter(e => others || (e.kind !== 'split' && e.user.toLowerCase() === me)).slice(0, 80)
  if (!rows.length) return <Empty title={t('feed.empty')} text="" />
  return (
    <div className="group membrane" style={{ marginTop: 8 }}>
      {rows.map(e => {
        const target = e.kind === 'split' ? e.c0 : e.node
        const mine = e.kind !== 'split' && e.user.toLowerCase() === me
        return (
          <button key={e.key} className="cell" onClick={() => !p.nodes[target]?.split && p.onSelect(target)}>
            {e.kind === 'deposit' && <span className="badge in"><ArrowDownLeft size={16} strokeWidth={2.25} /></span>}
            {e.kind === 'withdraw' && <span className="badge out"><ArrowUpRight size={16} strokeWidth={2.25} /></span>}
            {e.kind === 'split' && <span className="badge split"><GitFork size={16} strokeWidth={2.25} /></span>}
            <span className="k">
              {e.kind === 'split' ? t('feed.split') : e.kind === 'deposit' ? t('feed.deposit') : t('feed.withdraw')}
              <span className="sub">{e.kind === 'split' ? `${e.parent} → ${e.c0}, ${e.c1}` : `${mine ? 'You' : short(e.user)} · ${e.node}`}</span>
            </span>
            {e.kind !== 'split' && <span className={mine ? 'v strong gold' : 'v'}>{e.kind === 'withdraw' ? '−' : '+'}{fmtUsd(e.amount)}</span>}
          </button>
        )
      })}
    </div>
  )
}

// ------------------------------------------------------------------- shared

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="cell">
      <span className="k">{k}</span>
      <span className="v">{v}</span>
    </div>
  )
}

function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty">
      <Inbox size={28} strokeWidth={1.75} style={{ color: 'var(--text-3)', marginBottom: 10 }} />
      <div className="t">{title}</div>
      {text && <div>{text}</div>}
    </div>
  )
}
