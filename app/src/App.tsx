import { useEffect, useRef, useState, useCallback } from 'react'
import {
  assertLocalChain, readNodes, readEvents, claimOf, chancesAt, yourWallet, deposit, withdrawWhole,
  publicClient, you, usd, USDC_UNIT, PRESET, type ChainNode,
} from './chain'
import { Field } from './field'
import './app.css'

type Selected = { id: number; total: bigint; claim: bigint; roll: bigint; split: bigint }

const pct = (wad: bigint) => {
  const v = Number(wad) / 1e16
  return v >= 1 ? `${v.toFixed(2)}%` : v >= 0.01 ? `${v.toFixed(3)}%` : `${v.toFixed(5)}%`
}
const fmt = (x: bigint) => usd(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const fieldRef = useRef<Field | null>(null)
  const nodesRef = useRef<ChainNode[]>([])
  const [error, setError] = useState<string | null>(null)
  const [stats, setStats] = useState({ live: 0, splits: 0, block: 0n })
  const [sel, setSel] = useState<Selected | null>(null)
  const [anchor, setAnchor] = useState<{ x: number; y: number; r: number } | null>(null)
  const [wallet, setWallet] = useState<bigint>(0n)
  const [amount, setAmount] = useState('10')
  const [busy, setBusy] = useState<string | null>(null)
  const [chrome, setChrome] = useState(true)

  // ------------------------------------------------------------ chain loop
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const field = new Field(canvas, you.address)
    fieldRef.current = field
    let cancelled = false
    let cursor = 0n

    const onResize = () => field.resize()
    window.addEventListener('resize', onResize)

    const boot = async () => {
      await assertLocalChain()
      // History: rebuild the tree as it was born, instantly, so bubbles land in the right nodes.
      const head = await publicClient.getBlockNumber()
      const history = await readEvents(0n, head)
      const nodes = await readNodes()
      if (cancelled) return // React dev mode mounts twice; only the live mount draws
      nodesRef.current = nodes
      replay(field, nodes, history)
      field.sync(nodes)
      cursor = head + 1n
      field.start()
      if (import.meta.env.DEV) (window as unknown as { __field: Field }).__field = field
      setWallet(await yourWallet())

      while (!cancelled) {
        try {
          const tip = await publicClient.getBlockNumber()
          if (tip >= cursor) {
            const events = await readEvents(cursor, tip)
            cursor = tip + 1n
            if (events.length) {
              const fresh = await readNodes()
              nodesRef.current = fresh
              // children of a split must exist (as pending) before their own deposits land
              field.apply(events.filter(e => e.kind !== 'split'))
              field.apply(events.filter(e => e.kind === 'split'))
              field.sync(fresh)
              setWallet(await yourWallet())
            }
            setStats({
              live: nodesRef.current.filter(n => !n.split).length,
              splits: (nodesRef.current.length - 1) / 2,
              block: tip,
            })
          }
        } catch (e) {
          console.warn(e)
        }
        await new Promise(r => setTimeout(r, 700))
      }
    }
    boot().catch(e => setError(e instanceof Error ? e.message : String(e)))

    return () => {
      cancelled = true
      field.stop()
      window.removeEventListener('resize', onResize)
    }
  }, [])

  // ------------------------------------------------ selection and anchors
  const refreshSelected = useCallback(async (id: number) => {
    const node = nodesRef.current[id]
    if (!node || node.split) {
      setSel(null)
      return
    }
    const [claim, ch] = await Promise.all([claimOf(id), chancesAt(id, node.total)])
    setSel({ id, total: node.total, claim, roll: ch.roll, split: ch.split })
  }, [])

  useEffect(() => {
    const field = fieldRef.current
    if (!field) return
    field.onFrame = () => {
      if (field.selected == null) return setAnchor(a => (a ? null : a))
      const s = field.screenOf(field.selected)
      setAnchor(prev => (s && prev && Math.abs(prev.x - s.x) < 0.5 && Math.abs(prev.y - s.y) < 0.5 && Math.abs(prev.r - s.r) < 0.5 ? prev : s))
    }
    return () => { field.onFrame = null }
  }, [stats.block === 0n])

  useEffect(() => {
    if (sel == null) return
    const id = sel.id
    const timer = setInterval(() => {
      if (fieldRef.current?.selected !== id) return setSel(null)
      refreshSelected(id)
    }, 1200)
    return () => clearInterval(timer)
  }, [sel?.id, refreshSelected])

  const onClick = (e: React.MouseEvent) => {
    const field = fieldRef.current
    if (!field) return
    const rect = (e.target as HTMLElement).getBoundingClientRect()
    const hit = field.pick(e.clientX - rect.left, e.clientY - rect.top)
    field.selected = hit?.id ?? null
    if (hit) refreshSelected(hit.id)
    else setSel(null)
  }

  // --------------------------------------------------------------- actions
  const act = async (label: string, fn: () => Promise<void>) => {
    setBusy(label)
    try {
      await fn()
      if (sel) await refreshSelected(sel.id)
      setWallet(await yourWallet())
    } catch (e) {
      setError(e instanceof Error ? e.message.split('\n')[0] : String(e))
      setTimeout(() => setError(null), 5000)
    } finally {
      setBusy(null)
    }
  }

  const amountUnits = (() => {
    const n = Number(amount)
    return Number.isFinite(n) && n > 0 ? BigInt(Math.round(n * 1e6)) : 0n
  })()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return
      if (e.key === 'h' || e.key === 'H') setChrome(c => !c)
      if (e.key === 'Escape' && fieldRef.current) {
        fieldRef.current.selected = null
        setSel(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ------------------------------------------------------------------ view
  const panelLeft = anchor ? Math.min(window.innerWidth - 276, Math.max(16, anchor.x + anchor.r + 24)) : 0
  const panelTop = anchor ? Math.min(window.innerHeight - 260, Math.max(16, anchor.y - 110)) : 0

  return (
    <div className="stage">
      <canvas ref={canvasRef} className="field" onClick={onClick} />

      <div className={`hud ${chrome ? '' : 'hidden'}`}>
        <span>{stats.live} nodes</span>
        <span>{stats.splits} splits</span>
        <span>block {stats.block.toString()}</span>
        <span className="dim">local chain{PRESET === 'demo' ? ' · demo odds' : ''}</span>
      </div>

      <div className={`you ${chrome ? '' : 'hidden'}`}>
        <span className="dot" /> you · {fmt(wallet)} USDC
      </div>

      {sel && anchor && chrome && (
        <div className="panel" style={{ left: panelLeft, top: panelTop }}>
          <div className="row head">
            <span>Node {sel.id}</span>
            <button className="x" onClick={() => { if (fieldRef.current) fieldRef.current.selected = null; setSel(null) }}>×</button>
          </div>
          <div className="row"><span className="k">Holds</span><span className="v">{fmt(sel.total)} USDC</span></div>
          <div className="row"><span className="k">Roll chance</span><span className="v">{pct(sel.roll)}</span></div>
          <div className="row"><span className="k">Split chance</span><span className="v">{pct(sel.split)}</span></div>
          <div className="row"><span className="k">Your claim</span><span className="v gold">{fmt(sel.claim)} USDC</span></div>
          <div className="row input">
            <input value={amount} onChange={e => setAmount(e.target.value)} inputMode="decimal" aria-label="Amount in USDC" />
            <span className="unit">USDC</span>
          </div>
          <div className="row actions">
            <button
              disabled={!!busy || amountUnits < USDC_UNIT}
              onClick={() => act('deposit', () => deposit(sel.id, amountUnits))}
            >{busy === 'deposit' ? 'Depositing' : 'Deposit'}</button>
            <button
              className="ghost"
              disabled={!!busy || sel.claim === 0n}
              onClick={() => act('withdraw', () => withdrawWhole(sel.id))}
            >{busy === 'withdraw' ? 'Withdrawing' : 'Withdraw all'}</button>
          </div>
        </div>
      )}

      {error && <div className="toast">{error}</div>}
      <div className={`hint ${chrome ? '' : 'hidden'}`}>Click a node · H hides the interface</div>
    </div>
  )
}

/** Plays chain history into the field instantly, in the order it happened. */
function replay(field: Field, finalNodes: ChainNode[], history: Awaited<ReturnType<typeof readEvents>>) {
  // Start with the root only; every other node is born from a split event.
  const root = finalNodes[0]
  field.sync([{ ...root, split: false }])
  for (const e of history) {
    if (e.kind === 'split') {
      field.apply([e], true)
      const kids = [finalNodes[e.c0], finalNodes[e.c1]].filter(Boolean).map(k => ({ ...k, split: false }))
      field.sync(kids)
    } else {
      field.apply([e], true)
    }
  }
}
