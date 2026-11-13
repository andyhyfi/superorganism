// Play-money demo (Superorganism, working name): the same colony view and menus as the onchain app,
// driven by the game server instead of a chain. ENERGY replaces USDC; BLOOM is a game number.
// New game screens (objectives, mutations, sinks, Bloom moment, era/epoch) are PLACEHOLDERS until
// Andy's design: plain glass rows in the existing style. Map of states: app/STATE.md (Demo).
import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react'
import { Plus, Minus, Maximize2, LayoutList, Waves, Volume2, VolumeX } from 'lucide-react'
import { Field } from '../field'
import { attachGestures } from '../gestures'
import { Deep, type Tab, type Sheet, type SelectedInfo } from '../Deep'
import { toUnits } from '../format'
import { Guide, guideAtStart, markGuideSeen } from '../Guide'
import { GUIDE, t } from '../reveal'
import { Orb } from '../Tabs'
import { Rolling } from '../Rolling'
import { sound } from '../sound'
import { installCellTexture } from '../cellTexture'
import { setNames } from '../names'
import { setUnit } from '../unit'
import { tx, txIdle, txBusy, notice, NOTICE_MS, type TxKind } from '../machines'
import type { ChainNode, LoanLink, NetEvent } from '../chain'
import type { Address } from 'viem'
import {
  ADMIN, ApiError, U, act, board, divChance, live, loadMe, netEvents, signIn, signOut, signUp, testPlayer,
  type Board, type GameEvent, type Me, type Message, type View,
} from './server'
import { GamePanels, DemoControls, SignIn, BloomFlash } from './panels'
import '@fontsource/capriola/latin-400.css'
import '../app.css'
import '../cell.css'
import './demo.css'

installCellTexture()
setUnit('ENERGY')
document.title = 'Superorganism'

type Mode = 'aquarium' | 'deep'
const NARROW = '(max-width: 720px) and (orientation: portrait)'
const SHEET_H: Record<Sheet, number> = { peek: 0.22, half: 0.52, full: 0.92 }
const CARDS = GUIDE.filter(c => c.kind !== 'fee') // the demo has no fees
const INVITE = new URLSearchParams(location.search).get('invite')

export default function DemoApp() {
  const canvasRef = useRef<HTMLDivElement>(null)
  const fieldRef = useRef<Field | null>(null)
  const [view, setView] = useState<View | null>(null)
  const boardRef = useRef<Board | null>(null)
  const [me, setMe] = useState<Me | null>(null)
  const meRef = useRef(me)
  meRef.current = me
  const [checked, setChecked] = useState(false) // saved session looked up
  const [feed, setFeed] = useState<NetEvent[]>([])
  const [linkUp, setLinkUp] = useState(true)
  const [txState, txSend] = useReducer(tx, txIdle)
  const [note, noteSend] = useReducer(notice, null)
  const busy = txBusy(txState)
  const busyRef = useRef<TxKind | null>(busy)
  busyRef.current = busy
  const [selId, setSelId] = useState<number | null>(null)
  const selRef = useRef(selId)
  selRef.current = selId
  const [amount, setAmount] = useState('')
  const [mode, setMode] = useState<Mode>('aquarium')
  const [tab, setTab] = useState<Tab>('network')
  const [sheet, setSheet] = useState<Sheet>('half')
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches)
  const [idle, setIdle] = useState(false)
  const [bloom, setBloom] = useState<{ key: number; mine: number } | null>(null)
  const [fade, setFade] = useState(false) // new epoch: the old colony fades out, the new one in
  const soundOn = useSyncExternalStore(sound.subscribe, sound.snapshot)
  useEffect(() => { sound.resumeSaved() }, [])
  const [guideStep, setGuideStep] = useState<number | null>(() => (guideAtStart() ? 0 : null))
  const guideRef = useRef(guideStep)
  guideRef.current = guideStep
  const closeGuide = useCallback(() => { setGuideStep(null); markGuideSeen() }, [])
  const say = useCallback((text: string) => noteSend({ type: 'show', text }), [])

  // ------------------------------------------------------------ session
  useEffect(() => { loadMe().then(m => { setMe(m); setChecked(true) }) }, [])
  useEffect(() => { fieldRef.current?.setYou(me?.id ?? '') }, [me?.id])

  // ------------------------------------------------------------ field + live updates
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const field = new Field(canvas, '' as Address)
    fieldRef.current = field
    let cancelled = false
    let epochKey = ''
    const onResize = () => field.resize()
    window.addEventListener('resize', onResize)
    const detach = attachGestures(canvas, {
      onTap: (x, y) => {
        const hit = field.pick(x, y)
        if (hit) { field.focus(hit.id); return selectRef.current(hit.id) }
        selectRef.current(null)
        setMode('aquarium')
      },
      onDoubleTap: (x, y) => {
        const hit = field.pick(x, y)
        if (hit) { field.focus(hit.id); selectRef.current(hit.id) } else field.fitAll()
      },
      onPan: (dx, dy) => field.pan(dx, dy),
      onZoom: (x, y, f) => field.zoomAt(x, y, f),
      onDown: () => field.hold(),
      onPanEnd: () => field.release(),
      onScroll: (dx, dy) => field.pan(dx, dy, false),
    })

    /** Draws a whole colony at once: cells, their feeders' specks, loans. */
    const seed = (b: Board) => {
      field.sync(b.nodes)
      const feeds: NetEvent[] = []
      for (const [id, s] of b.specs) {
        for (const [pid, amt] of Object.entries(s.claims)) feeds.push({ kind: 'deposit', node: id, user: pid as Address, amount: U(amt), key: `seed${id}${pid}`, block: 0n })
      }
      field.apply(feeds, true)
      field.setLinks(b.links)
    }

    const onMsg = (m: Message) => {
      if (cancelled) return
      const v: View = m
      const b = board(v)
      const key = `${v.summary.era}.${v.summary.epoch}`
      const fresh = epochKey !== key
      const first = epochKey === ''
      epochKey = key
      setNames(b.names)
      if (m.type === 'events') handleGame(m.events)
      if (fresh || m.type === 'snapshot') {
        if (first || !fresh) {
          // first load, or a reconnect inside the same epoch: redraw, keeping the selection if it still lives
          field.clear(); seed(b)
          const keep = selRef.current
          if (!fresh && keep != null && b.nodes[keep] && !b.nodes[keep].split && !b.nodes[keep].gone) field.selected = keep
          else if (fresh) setSel(null)
        } else {
          // a new epoch: fade the old colony out, swap, fade the new one in (no jump)
          setFade(true)
          window.setTimeout(() => { field.clear(); seed(boardRef.current ?? b); setFade(false) }, 900)
          setSel(null)
        }
      } else {
        const events = netEvents(m.events, b, v.summary)
        field.apply(events.filter(e => e.kind !== 'split' && e.kind !== 'loan'))
        field.apply(events.filter(e => e.kind === 'split'))
        field.sync(b.nodes)
        field.apply(events.filter(e => e.kind === 'loan'))
        field.setLinks(b.links)
        playEvents(field, events)
        const shown = events.filter(e => e.kind !== 'repay')
        if (shown.length) setFeed(f => [...[...shown].reverse(), ...f].slice(0, 200))
      }
      boardRef.current = b
      setView(v)
    }

    // Bloom, failed epoch, new epoch: the moments everyone sees (placeholder copy)
    const handleGame = (events: GameEvent[]) => {
      const mine = meRef.current?.id
      let refresh = false
      for (const e of events) {
        if (e.type === 'bloom') {
          const shares = e.shares as Record<string, number>
          setBloom({ key: Date.now(), mine: mine ? shares[mine] ?? 0 : 0 })
          sound.play('split', 0, 7)
          refresh = true
        } else if (e.type === 'fail') {
          say('The epoch closed without a Bloom.')
          refresh = true
        } else if (mine && (e.player === mine || e.from === mine)) refresh = true
      }
      if (refresh && meRef.current) loadMe().then(m => m && setMe(m))
    }

    field.ready.then(() => { if (!cancelled) field.start() })
    if (import.meta.env.DEV) (window as unknown as { __field: Field }).__field = field
    const stop = live(onMsg, up => setLinkUp(up))
    return () => {
      cancelled = true
      stop()
      field.destroy()
      detach()
      window.removeEventListener('resize', onResize)
    }
  }, [say])

  // ------------------------------------------------------------ selection
  const nodes: ChainNode[] = boardRef.current?.nodes ?? []
  const links: LoanLink[] = boardRef.current?.links ?? []
  const b = boardRef.current
  const serverOf = (id: number) => b?.server[id]
  const claimOf = (id: number) => {
    const sid = serverOf(id)
    return U(sid === undefined ? 0 : me?.placed[sid] ?? 0)
  }
  const claims = new Map<number, bigint>()
  if (b && me) for (const [sid, amt] of Object.entries(me.placed)) {
    const id = b.local.get(Number(sid))
    if (id !== undefined && amt > 0) claims.set(id, U(amt))
  }
  // a selected specimen that divided shows its first child at once (never a blank menu while the halves part)
  let node = selId != null ? nodes[selId] : undefined
  for (let k = 0; node?.split && k < 50; k++) node = nodes[node.firstChild]
  const sel: SelectedInfo | null = node && view && !node.split && !node.gone ? {
    id: node.id, total: node.total, energy: node.energy, lent: node.lent, borrowed: node.borrowed, claim: claimOf(node.id),
    roll: BigInt(Math.round(divChance(view.summary, Number(node.energy) / 1e6) * 1e18)),
    split: BigInt(Math.round(divChance(view.summary, Number(node.energy) / 1e6) * 1e18)),
  } : null

  const setSel = (id: number | null) => {
    setSelId(id)
    if (fieldRef.current) fieldRef.current.selected = id
  }
  const select = useCallback((id: number | null) => {
    const field = fieldRef.current
    if (!field) return
    field.selected = id
    setSelId(id)
    setAmount('')
    if (id == null) { field.fitAll(); return }
    setMode('deep')
    setTab('node')
    const g = guideRef.current
    if (g != null && CARDS[g]?.kind === 'tap') setGuideStep(g + 1)
  }, [])
  const selectRef = useRef(select)
  selectRef.current = select

  // the selected specimen divided: the menu follows its first child
  useEffect(() => {
    const f = fieldRef.current
    if (!f) return
    f.onSelectionMoved = id => setSelId(id)
    return () => { f.onSelectionMoved = undefined }
  })
  useEffect(() => {
    if (selId == null || !node) return
    if (node.id !== selId && !node.split && !node.gone) setSel(node.id)
    else if (node.gone && claimOf(node.id) === 0n) setSel(null)
  }, [view]) // eslint-disable-line react-hooks/exhaustive-deps

  // ------------------------------------------------------------ layout (same as the onchain app)
  useEffect(() => {
    const mq = window.matchMedia(NARROW)
    const on = () => setNarrow(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  useEffect(() => {
    const field = fieldRef.current
    if (!field) return
    if (mode === 'deep' && narrow) field.setInset(0, Math.round(window.innerHeight * SHEET_H[sheet]))
    else field.setInset(0, 0)
    field.setAutoReturn(mode === 'aquarium' ? 15000 : null)
  }, [mode, narrow, sheet])
  useEffect(() => {
    if (mode !== 'aquarium') return setIdle(false)
    let timer = 0
    const wake = () => { setIdle(false); clearTimeout(timer); timer = window.setTimeout(() => setIdle(true), 4000) }
    wake()
    const evs = ['pointermove', 'pointerdown', 'keydown', 'wheel'] as const
    evs.forEach(e => window.addEventListener(e, wake))
    return () => { clearTimeout(timer); evs.forEach(e => window.removeEventListener(e, wake)) }
  }, [mode])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return
      const field = fieldRef.current
      const k = e.key.toLowerCase()
      if (k === 'tab') { e.preventDefault(); setMode(m => (m === 'deep' ? 'aquarium' : 'deep')) }
      else if (k === 'escape') { if (field?.selected != null) select(null); else setMode('aquarium') }
      else if (k === 'f') field?.fitAll()
      else if (k === '=' || k === '+') field?.zoomBy(1.25)
      else if (k === '-' || k === '_') field?.zoomBy(0.8)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [select])

  // ------------------------------------------------------------ notices
  useEffect(() => {
    if (!note || note.sticky) return
    const id = note.id
    const timer = window.setTimeout(() => noteSend({ type: 'expire', id }), NOTICE_MS)
    return () => clearTimeout(timer)
  }, [note])
  const [down, setDown] = useState(false)
  useEffect(() => {
    if (linkUp) { setDown(false); return }
    const timer = window.setTimeout(() => setDown(true), 3000) // a blip is not worth a message
    return () => clearTimeout(timer)
  }, [linkUp])
  useEffect(() => {
    if (down) noteSend({ type: 'show', text: t('link.lost'), sticky: true })
    else noteSend({ type: 'clearSticky' })
  }, [down])

  // ------------------------------------------------------------ actions (one at a time)
  const run = async (kind: TxKind, body: Record<string, unknown>) => {
    if (busyRef.current) return
    busyRef.current = kind
    txSend({ type: 'start', kind })
    try {
      setMe(await act(body))
      if (kind !== 'game') setAmount('')
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setMe(null)
      say(friendly(e))
    } finally {
      txSend({ type: 'end' })
    }
  }
  const game = (body: Record<string, unknown>) => run('game', body)
  const units = toUnits(amount)
  const heldIds = [...claims.keys()]
  const held = [...claims.values()].reduce((a, c) => a + c, 0n)

  // ------------------------------------------------------------ view
  const live_ = nodes.filter(n => n && !n.split && !n.gone).length
  const overlay = mode === 'aquarium' && !idle
  const ctrlCls = [
    'controls glass membrane',
    mode === 'deep' || overlay ? '' : 'hidden',
    mode === 'deep' && !narrow ? 'side-open' : '',
    mode === 'deep' && narrow ? `sheet-${sheet}` : '',
  ].join(' ')
  const s = view?.summary
  const guideKind = guideStep != null ? CARDS[guideStep]?.kind : undefined
  const panel = (part: 'colony' | 'specimen' | 'yours', spec?: number) => view && me ? (
    <GamePanels part={part} spec={spec} view={view} me={me} busy={!!busy} serverOf={serverOf} game={game}
      colorsOf={id => fieldRef.current?.colorsOf(id)} onSignOut={async () => { await signOut(); setMe(null) }} />
  ) : null

  return (
    <div
      className={`stage demo mode-${mode} ${guideKind ? `guide-${guideKind}` : ''}`}
      data-mode={mode} data-tab={tab} data-sheet={narrow ? sheet : 'side'} data-selected={selId ?? ''}
      data-tx={txState.phase === 'idle' ? 'idle' : `${txState.kind}:${txState.phase}`}
      data-link={down ? 'down' : 'live'} data-guide={guideStep ?? 'closed'} data-sound={soundOn ? 'on' : 'off'}
      data-signed={me ? 'in' : 'out'} data-epoch={s ? `${s.era}.${s.epoch}` : ''}
    >
      <div ref={canvasRef} className={`field ${fade ? 'epoch-fade' : ''}`} />
      <BloomFlash bloom={bloom} onDone={() => setBloom(null)} />

      <div className={`top ${overlay ? '' : 'hidden'}`}>
        <span className="pill glass membrane">
          {live_} {live_ === 1 ? 'specimen' : 'specimens'}
          {s && <span className="sub">Era {s.era + 1} · Epoch {s.epoch + 1}</span>}
        </span>
      </div>

      {me && (
        <div className="money glass membrane" role="button" tabIndex={0} aria-label={t('hud.myCells')}
          onClick={() => { setMode('deep'); setTab('yours'); if (narrow && sheet === 'peek') setSheet('half') }}>
          <span className="m"><span className="sub">ENERGY</span><span className="num"><Rolling value={U(me.dEnergy)} /></span></span>
          <span className="divider" />
          <span className="m"><span className="sub">{t('hud.deposited')}</span><span className="num gold"><Rolling value={held} /></span></span>
          <span className="divider" />
          <span className="m"><span className="sub">BLOOM</span><span className="num bloom"><Rolling value={U(me.bloom)} /></span></span>
          <span className="mine cell-quiet" aria-hidden="true">
            <span className="orbs">{heldIds.slice(0, 3).map(id => <Orb key={id} colors={fieldRef.current?.colorsOf(id)} size={14} />)}</span>
            {heldIds.length}
          </span>
        </div>
      )}

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
          nodes={nodes} feed={feed} you={(me?.id ?? '') as Address} selected={me ? sel : null} claims={claims}
          fees={0n} odds={0n} wallet={U(me?.dEnergy ?? 0)} busy={busy} amount={amount} setAmount={setAmount}
          links={links} limits={{ maxDeposit: 0n, maxPerUser: 0n, eventFee: 0n }} heldNet={held} netDeposited={U(me?.stake ?? 0)}
          onSelect={id => { select(id); fieldRef.current?.focus(id) }}
          onFocus={id => fieldRef.current?.focus(id)}
          onDeposit={() => sel && run('deposit', { type: 'feed', spec: serverOf(sel.id), amount: Number(units) / 1e6 })}
          onWithdraw={u => sel && run('withdraw', { type: 'draw', spec: serverOf(sel.id), amount: Number(u) / 1e6 })}
          onWithdrawAll={() => run('withdrawAll', { type: 'drawAll' })}
          onClose={() => { select(null); setMode('aquarium') }}
          colorsOf={id => fieldRef.current?.colorsOf(id)}
          demo
          nodeExtra={id => panel('specimen', id)}
          networkExtra={panel('colony')}
          yoursExtra={panel('yours')}
        />
      )}

      {checked && !me && (
        <SignIn
          invite={INVITE}
          onSignUp={async () => { try { setMe(await signUp(INVITE)) } catch (e) { say(friendly(e)) } }}
          onSignIn={async () => { try { setMe(await signIn()) } catch (e) { say(friendly(e)) } }}
          onTest={ADMIN ? async (name: string) => { try { setMe(await testPlayer(name)) } catch (e) { say(friendly(e)) } } : undefined}
        />
      )}

      {ADMIN && s && <DemoControls summary={s} say={say} />}

      {me && guideStep != null && (
        <Guide
          step={guideStep} feePpm={0} catalyst="" cards={CARDS}
          side={mode === 'deep' && !narrow}
          onStep={n => {
            const kind = CARDS[n]?.kind
            if (kind === 'feed' && selId == null) {
              const big = nodes.filter(x => x && !x.split && !x.gone).sort((x, y) => (y.energy > x.energy ? 1 : -1))[0]
              if (big) { select(big.id); fieldRef.current?.focus(big.id) }
            }
            if (kind === 'feed') { setMode('deep'); setTab('node'); if (narrow && sheet === 'peek') setSheet('half') }
            setGuideStep(n)
          }}
          onClose={closeGuide}
          onDone={() => { closeGuide(); select(null); setMode('aquarium') }}
        />
      )}

      {note && <div className="toast" role="status" key={note.id}>{note.text}</div>}
    </div>
  )
}

/** Server and passkey errors as one plain sentence (placeholder copy). */
function friendly(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  if (e instanceof Error && (e.name === 'NotAllowedError' || /not allowed|cancel/i.test(m))) return 'Cancelled.'
  if (/Failed to fetch|NetworkError|network/i.test(m)) return 'Connection lost. Nothing was sent. Try again in a moment.'
  if (/sign in first/.test(m)) return 'Signed out. Sign in again.'
  if (/not enough dENERGY/.test(m)) return 'Not enough ENERGY.'
  if (/not enough BLOOM/.test(m)) return 'Not enough BLOOM.'
  return m.charAt(0).toUpperCase() + m.slice(1) + '.'
}

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
