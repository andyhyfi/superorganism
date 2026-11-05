import { useEffect, useRef, useState, useCallback, useSyncExternalStore } from 'react'
import {
  assertLocalChain, readNetwork, readEvents, claimOf, chancesAt, yourWallet, yourHeld, yourNetDeposited, deposit, withdrawAmount,
  claimsOf, withdrawEverything, feesOwed, splitOdds, limits as readLimits, readDials, setDials,
  publicClient, you, PRESET, type ChainNode, type NetEvent, type LoanLink, type Dials,
} from './chain'
import { Field } from './field'
import { attachGestures } from './gestures'
import { Deep, type Tab, type Sheet, type SelectedInfo } from './Deep'
import { toUnits } from './format'
import { Plus, Minus, Maximize2, LayoutList, Waves, Volume2, VolumeX } from 'lucide-react'
import { sound } from './sound'
import { installCellTexture } from './cellTexture'
import { isRevealAll, setRevealAll, t } from './reveal'
import { Orb } from './Tabs'
import { TestDials } from './TestDials'
import { Rolling } from './Rolling'
import '@fontsource/capriola/latin-400.css' // display font (one weight, 400), self-hosted
import './app.css'
import './cell.css'

installCellTexture()

type Mode = 'aquarium' | 'deep'
// Bottom sheet only on narrow screens held upright; a phone held sideways gets the side panel.
const NARROW = '(max-width: 720px) and (orientation: portrait)'
const SHEET_H: Record<Sheet, number> = { peek: 0.22, half: 0.52, full: 0.92 }

export default function App() {
  const canvasRef = useRef<HTMLDivElement>(null)
  const fieldRef = useRef<Field | null>(null)
  const nodesRef = useRef<ChainNode[]>([])
  const [nodes, setNodes] = useState<ChainNode[]>([])
  const [feed, setFeed] = useState<NetEvent[]>([])
  const [error, setError] = useState<string | null>(null)
  const [block, setBlock] = useState(0n)
  const [sel, setSel] = useState<SelectedInfo | null>(null)
  const [claims, setClaims] = useState<Map<number, bigint>>(new Map())
  // sound: the engine holds the only on/off state; the button just shows it (stays right across
  // tabs, windows and apps). A saved "on" starts on the first tap, as browsers require.
  const soundOn = useSyncExternalStore(sound.subscribe, sound.snapshot)
  useEffect(() => { sound.resumeSaved() }, [])
  const [fees, setFees] = useState(0n)
  const [odds, setOdds] = useState(0n)
  const [wallet, setWallet] = useState(0n)
  const [heldNet, setHeldNet] = useState(0n)
  const [netDeposited, setNetDeposited] = useState(0n) // deposits minus withdrawals: gates network activity
  const [lim, setLim] = useState({ maxDeposit: 0n, maxPerUser: 0n, eventFee: 0n })
  const [links, setLinks] = useState<LoanLink[]>([])
  const [dials, setDialsState] = useState<Dials>({ splitPpm: 0, eventPpm: 0 })
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  const [mode, setMode] = useState<Mode>('aquarium')
  const [tab, setTab] = useState<Tab>('network')
  const [sheet, setSheet] = useState<Sheet>('half')
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches)
  const [chrome, setChrome] = useState(true) // Aquarium's light overlay; H toggles
  const [idle, setIdle] = useState(false)
  const [, setReveal] = useState(0) // dev: re-render after toggling reveal-all

  const refreshMine = async (all: ChainNode[]) => {
    const live = all.filter(n => !n.split && !n.gone).map(n => n.id)
    const [c, f, w, h, nd] = await Promise.all([claimsOf(live), feesOwed(), yourWallet(), yourHeld(), yourNetDeposited()])
    setClaims(new Map(live.map((id, i) => [id, c[i]])))
    setFees(f)
    setWallet(w)
    setHeldNet(h)
    setNetDeposited(nd)
  }

  // ------------------------------------------------------------ selection
  const refreshSelected = useCallback(async (id: number) => {
    const node = nodesRef.current[id]
    if (!node || node.split || (node.gone && !(claims.get(id) ?? 0n))) return setSel(null)
    const [claim, ch] = await Promise.all([claimOf(id), chancesAt(id, node.rollFill)])
    if (fieldRef.current?.selected !== id) return
    setSel({ id, total: node.total, energy: node.energy, lent: node.lent, borrowed: node.borrowed, claim, roll: ch.roll, split: ch.split })
  }, [])

  const select = useCallback((id: number | null) => {
    const field = fieldRef.current
    if (!field) return
    field.selected = id
    setAmount('') // every cell starts from an empty amount
    if (id == null) { field.fitAll(); return setSel(null) }
    refreshSelected(id)
    setMode('deep')
    setTab('node')
  }, [refreshSelected])
  /** The selected cell split: the menu moves to its first child, keeping the tab and the amount. */
  const carry = useCallback((id: number) => {
    const field = fieldRef.current
    if (field && field.screenOf(id)) field.selected = id // else the split hands it over when the halves part
    refreshSelected(id)
  }, [refreshSelected])
  const carryRef = useRef(carry)
  carryRef.current = carry
  const selectRef = useRef(select)
  selectRef.current = select

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

    const detach = attachGestures(canvas, {
      onTap: (x, y) => {
        const hit = field.pick(x, y)
        if (hit) { field.focus(hit.id); return selectRef.current(hit.id) }
        // a tap on open water closes the menu and returns to the aquarium
        selectRef.current(null)
        setMode('aquarium')
      },
      onDoubleTap: (x, y) => {
        const hit = field.pick(x, y)
        if (hit) { field.focus(hit.id); selectRef.current(hit.id) }
        else field.fitAll()
      },
      onPan: (dx, dy) => field.pan(dx, dy),
      onZoom: (x, y, f) => field.zoomAt(x, y, f),
      onDown: () => field.hold(),
      onPanEnd: () => field.release(),
      onScroll: (dx, dy) => field.pan(dx, dy, false),
    })

    const boot = async () => {
      await assertLocalChain()
      await field.ready
      // History: rebuild the tree as it was born, instantly, so bubbles land in the right nodes.
      const head = await publicClient.getBlockNumber()
      const history = await readEvents(0n, head)
      const net = await readNetwork()
      const all = net.nodes
      if (cancelled) return // React dev mode mounts twice; only the live mount draws
      nodesRef.current = all
      setNodes(all)
      setFeed([...history].reverse().slice(0, 200))
      replay(field, all, history)
      field.sync(all)
      field.setLinks(net.links)
      setLinks(net.links)
      cursor = head + 1n
      field.start()
      if (import.meta.env.DEV) (window as unknown as { __field: Field }).__field = field
      setOdds(await splitOdds())
      setLim(await readLimits())
      setDialsState(await readDials())
      await refreshMine(all)
      let lastLinks = 0

      while (!cancelled) {
        try {
          const tip = await publicClient.getBlockNumber()
          if (tip >= cursor) {
            const events = await readEvents(cursor, tip)
            cursor = tip + 1n
            // loans also end on their own at their due time, with no event: re-read every few seconds
            const stale = Date.now() - lastLinks > 4000
            if (events.length || stale) {
              lastLinks = Date.now()
              const net = await readNetwork()
              const fresh = net.nodes
              nodesRef.current = fresh
              setNodes(fresh)
              const shown = events.filter(e => e.kind !== 'repay')
              if (shown.length) setFeed(f => [...[...shown].reverse(), ...f].slice(0, 200))
              // children of a split must exist (as pending) before their own deposits land
              field.apply(events.filter(e => e.kind !== 'split' && e.kind !== 'loan'))
              field.apply(events.filter(e => e.kind === 'split'))
              field.sync(fresh)
              field.apply(events.filter(e => e.kind === 'loan'))
              field.setLinks(net.links)
              setLinks(net.links)
              playEvents(field, events)
              if (events.length) await refreshMine(fresh)
            }
            setBlock(tip)
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
      field.destroy()
      detach()
      window.removeEventListener('resize', onResize)
    }
  }, [])

  // a selected node that splits hands the selection to its first child: the menu follows it
  useEffect(() => {
    const f = fieldRef.current
    if (!f) return
    f.onSelectionMoved = id => carryRef.current(id)
    return () => { f.onSelectionMoved = undefined }
  })

  // keep the selected node's numbers fresh; if it split, move to its first child
  useEffect(() => {
    if (sel == null) return
    const cur = nodes[sel.id]
    if (cur?.split && nodes[cur.firstChild] && !nodes[cur.firstChild].split) {
      carryRef.current(cur.firstChild)
      return
    }
    if (cur?.split || (cur?.gone && !(claims.get(sel.id) ?? 0n))) {
      if (fieldRef.current) fieldRef.current.selected = null
      setSel(null)
      return
    }
    refreshSelected(sel.id)
  }, [nodes, block]) // eslint-disable-line react-hooks/exhaustive-deps

  // ------------------------------------------------------------- layout
  useEffect(() => {
    const mq = window.matchMedia(NARROW)
    const on = () => setNarrow(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])

  // the camera centers in the part of the screen the panel leaves free
  useEffect(() => {
    const field = fieldRef.current
    if (!field) return
    if (mode === 'aquarium') field.setInset(0, 0)
    else if (narrow) field.setInset(0, Math.round(window.innerHeight * SHEET_H[sheet]))
    else field.setInset(0, 0) // desktop: the menu opens over the view; the view itself stays put
    field.setAutoReturn(mode === 'aquarium' ? 15000 : null)
  }, [mode, narrow, sheet])

  // Aquarium: the overlay fades after a few still seconds and returns on any movement
  useEffect(() => {
    if (mode !== 'aquarium') return setIdle(false)
    let timer = 0
    const wake = () => {
      setIdle(false)
      clearTimeout(timer)
      timer = window.setTimeout(() => setIdle(true), 4000)
    }
    wake()
    const evs = ['pointermove', 'pointerdown', 'keydown', 'wheel'] as const
    evs.forEach(e => window.addEventListener(e, wake))
    return () => { clearTimeout(timer); evs.forEach(e => window.removeEventListener(e, wake)) }
  }, [mode])

  // -------------------------------------------------------------- keys
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return
      const field = fieldRef.current
      const k = e.key.toLowerCase()
      if (k === 'tab') { e.preventDefault(); setMode(m => (m === 'deep' ? 'aquarium' : 'deep')) }
      else if (k === 'escape') { if (field?.selected != null) select(null); else setMode('aquarium') }
      else if (k === 'h') setChrome(c => !c)
      else if (k === 'r' && import.meta.env.DEV) { setRevealAll(!isRevealAll()); setReveal(v => v + 1) }
      else if (k === 'f') field?.fitAll()
      else if (k === 'c' && field?.selected != null) field.focus(field.selected)
      else if (k === '=' || k === '+') field?.zoomBy(1.25)
      else if (k === '-' || k === '_') field?.zoomBy(0.8)
      else if (mode === 'deep' && ['1', '2', '3', '4'].includes(k)) setTab((['node', 'network', 'yours', 'feed'] as Tab[])[Number(k) - 1])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode, select])

  // ------------------------------------------------------------ actions
  const act = async (label: string, fn: () => Promise<void>) => {
    setBusy(label)
    try {
      await fn()
      await refreshMine(nodesRef.current)
      if (sel) await refreshSelected(sel.id)
    } catch (e) {
      setError(friendly(e))
      setTimeout(() => setError(null), 5000)
    } finally {
      setBusy(null)
    }
  }
  const units = toUnits(amount)
  const heldIds = [...claims.entries()].filter(([, c]) => c > 0n).map(([id]) => id)

  // ---------------------------------------------------------------- view
  const live = nodes.filter(n => !n.split && !n.gone).length
  const overlay = mode === 'aquarium' && chrome && !idle
  const ctrlCls = [
    'controls glass membrane',
    mode === 'deep' || overlay ? '' : 'hidden',
    mode === 'deep' && !narrow ? 'side-open' : '',
    mode === 'deep' && narrow ? `sheet-${sheet}` : '',
  ].join(' ')
  const held = [...claims.values()].reduce((a, c) => a + c, 0n)
  return (
    <div className={`stage mode-${mode}`}>
      <div ref={canvasRef} className="field" />

      <div className={`top ${overlay ? '' : 'hidden'}`}>
        <span className="pill glass membrane">
          {live} {live === 1 ? 'cell' : 'cells'}
          <span className="sub">{PRESET === 'splits' ? 'Local · split test' : PRESET === 'demo' ? 'Local · demo odds' : 'Local'}</span>
        </span>
      </div>

      {/* money: always on screen, in both modes */}
      <div
        className="money glass membrane"
        role="button"
        tabIndex={0}
        aria-label={t('hud.myCells')}
        onClick={() => { setMode('deep'); setTab('yours'); if (narrow && sheet === 'peek') setSheet('half') }}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setMode('deep'); setTab('yours') } }}
      >
        <span className="m"><span className="sub">{t('hud.wallet')}</span><span className="num"><Rolling value={wallet} /></span></span>
        <span className="divider" />
        <span className="m"><span className="sub">{t('hud.deposited')}</span><span className="num gold"><Rolling value={held} /></span></span>
        <span className="mine cell-quiet" aria-hidden="true">
          <span className="orbs">{heldIds.slice(0, 3).map(id => <Orb key={id} colors={fieldRef.current?.colorsOf(id)} size={14} />)}</span>
          {heldIds.length}
        </span>
      </div>

      <div className={ctrlCls}>
        <button aria-label="Zoom out" onClick={() => fieldRef.current?.zoomBy(0.8)}><Minus size={20} strokeWidth={2.25} /></button>
        <button aria-label="Fit colony" onClick={() => fieldRef.current?.fitAll()}><Maximize2 size={18} strokeWidth={2.25} /></button>
        <button aria-label="Zoom in" onClick={() => fieldRef.current?.zoomBy(1.25)}><Plus size={20} strokeWidth={2.25} /></button>
        <button aria-label={soundOn ? 'Sound off' : 'Sound on'} aria-pressed={soundOn} onClick={() => sound.toggle()}>
          {soundOn ? <Volume2 size={19} strokeWidth={2.25} /> : <VolumeX size={19} strokeWidth={2.25} />}
        </button>
        <span className="divider" />
        <button className="primary cell-btn" onClick={() => setMode(m => (m === 'deep' ? 'aquarium' : 'deep'))}>
          {mode === 'deep' ? <><Waves size={18} strokeWidth={2.25} />{t('mode.observe')}</> : <><LayoutList size={18} strokeWidth={2.25} />{t('mode.study')}</>}
        </button>
      </div>

      {mode === 'deep' && (
        <Deep
          tab={tab} setTab={setTab} sheet={sheet} setSheet={setSheet} narrow={narrow}
          nodes={nodes} feed={feed} you={you.address} selected={sel} claims={claims}
          fees={fees} odds={odds} wallet={wallet} busy={busy} amount={amount} setAmount={setAmount}
          links={links} limits={lim} heldNet={heldNet} netDeposited={netDeposited}
          onSelect={id => { select(id); fieldRef.current?.focus(id) }}
          onFocus={id => fieldRef.current?.focus(id)}
          onDeposit={() => sel && act('deposit', () => deposit(sel.id, units))}
          onWithdraw={u => sel && act('withdraw', () => withdrawAmount(sel.id, u, sel.claim))}
          onWithdrawAll={() => act('withdrawAll', () => withdrawEverything(heldIds))}
          onClose={() => { select(null); setMode('aquarium') }}
          colorsOf={id => fieldRef.current?.colorsOf(id)}
        />
      )}

      <TestDials
        dials={dials}
        onChange={d => {
          setDialsState(d)
          setDials(d).catch(e => { setError(friendly(e)); setTimeout(() => setError(null), 5000) })
        }}
      />

      {error && <div className="toast">{error}</div>}
    </div>
  )
}

/** Turns a chain or wallet error into one plain sentence (placeholder copy). */
function friendly(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  if (/HTTP request failed|fetch|network|Failed to fetch|timed? ?out/i.test(m)) return 'Connection lost. Nothing was sent. Try again in a moment.'
  if (/insufficient|exceeds balance/i.test(m)) return 'Not enough USDC in your wallet.'
  if (/rejected|denied/i.test(m)) return 'Cancelled.'
  if (/AboveMaxDeposit/.test(m)) return 'The most you can feed at once is 1,000 USDC.'
  if (/AboveUserLimit/.test(m)) return 'You can feed at most 1,000 USDC in total.'
  if (/revert/i.test(m)) return 'The colony refused this. Nothing was sent.'
  return m.split('\n')[0].slice(0, 120)
}

/** Plays chain history into the field instantly, in the order it happened. */
/** Live events to sound effects, panned to where each cell sits on screen. */
function playEvents(field: Field, events: NetEvent[]) {
  const panOf = (id: number) => {
    const p = field.screenOf(id)
    return p ? (p.x / window.innerWidth) * 2 - 1 : 0
  }
  for (const e of events) {
    if (e.kind === 'deposit') sound.play('deposit', panOf(e.node), e.node)
    else if (e.kind === 'withdraw') sound.play('withdraw', panOf(e.node), e.node)
    else if (e.kind === 'split') sound.play('split', panOf(e.c0), e.parent)
    else if (e.kind === 'loan') sound.play('loan', panOf(e.borrower), e.lender, e.borrower)
    else if (e.kind === 'repay') sound.play('repay', panOf(e.lender), e.lender, e.lender + 2)
  }
}

function replay(field: Field, finalNodes: ChainNode[], history: NetEvent[]) {
  // Start with the root only; every other node is born from a split event.
  const root = finalNodes[0]
  field.sync([{ ...root, split: false, gone: false }])
  for (const e of history) {
    field.apply([e], true)
    if (e.kind === 'split') {
      const kids = [finalNodes[e.c0], finalNodes[e.c1]].filter(Boolean).map(k => ({ ...k, split: false, gone: false }))
      field.sync(kids)
    }
  }
}
