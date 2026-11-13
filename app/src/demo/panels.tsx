// Demo game screens. ALL PLACEHOLDERS until Andy's design: plain glass rows in the app's style.
// Standing rules kept: objective progress is graphic only (no numbers); hidden mechanics are not
// explained; every word here is throwaway copy. Andy designs objectives, BLOOM, mutations, sinks,
// the Bloom moment and the era/epoch indicator.
import { useEffect, useState } from 'react'
import { Orb } from '../Tabs'
import { nameOf } from '../names'
import { ADMIN, admin, fmtNum, mutationName, testPlayer, type Me, type SinkKind, type Summary, type View } from './server'
import { SPECIES } from '../species'

type Colors = { dark: string; light: string; core: string; rim: string }

type Props = {
  part: 'colony' | 'specimen' | 'yours'
  spec?: number // screen id (specimen part)
  view: View
  me: Me
  busy: boolean
  serverOf: (id: number) => number | undefined
  game: (body: Record<string, unknown>) => void
  colorsOf: (id: number) => Colors | undefined
  onSignOut: () => void
}

const SINK_WORD: Record<SinkKind, string> = { name: 'Name', color: 'Color', steer: 'Steer a loan' }

export function GamePanels(p: Props) {
  if (p.part === 'colony') return <Objectives s={p.view.summary} history={p.view.history} />
  if (p.part === 'yours') return <Yours {...p} />
  return <SpecimenGame {...p} />
}

// ---------------------------------------------------------------- objectives (colony tab)
function Bar({ fill, ok }: { fill: number; ok?: boolean }) {
  return <span className="obj-bar"><span className={ok ? 'ok' : ''} style={{ width: `${Math.max(2, Math.min(100, fill * 100))}%` }} /></span>
}

function Objectives({ s, history }: { s: Summary; history: View['history'] }) {
  const o = s.objective
  const traits = Object.entries(o.traits)
  // the hold: how far through the hold time the colony is (graphic only)
  const held = s.holdSince === null ? 0 : (s.now - s.holdSince) / 3_600_000 / Math.max(o.holdH, 0.5)
  const timeLeft = Math.max(0, (s.deadline - s.now) / (s.deadline - s.epochStart))
  return (
    <>
      <div className="section-title">Objectives</div>
      <div className="group membrane">
        <div className="cell obj"><span className="k">Specimens</span><Bar fill={o.qualifying / o.nReq} ok={o.qualifying >= o.nReq} /></div>
        {traits.map(([m, need]) => {
          const short = o.short[m] ?? 0
          return <div key={m} className="cell obj"><span className="k">{mutationName(Number(m))}</span><Bar fill={(need - short) / need} ok={!short} /></div>
        })}
        {s.epoch >= (s.era === 0 ? 2 : 0) && (
          <div className="cell obj"><span className="k">No empty specimens</span><Bar fill={o.empties ? 0 : 1} ok={!o.empties} /></div>
        )}
        <div className="cell obj"><span className="k">Held</span><Bar fill={o.ok ? held : 0} ok={o.ok && held >= 1} /></div>
        <div className="cell obj"><span className="k">Time</span><Bar fill={timeLeft} /></div>
      </div>
      {history.length > 0 && (
        <>
          <div className="section-title">Epochs</div>
          <div className="group membrane epochs">
            {history.slice(-10).map((h, i) => (
              <span key={i} className={h.bloomed ? 'ep bloomed' : 'ep'} title={`Era ${h.era + 1} · Epoch ${h.epoch + 1}`} />
            ))}
          </div>
        </>
      )}
    </>
  )
}

// ---------------------------------------------------------------- you (yours tab)
function Yours({ view, me, busy, game, onSignOut }: Props) {
  const s = view.summary
  const traits = Object.keys(s.objective.traits).map(Number)
  const [copied, setCopied] = useState(false)
  const invite = me.invites.find(i => !i.used_by)
  const share = async () => {
    let code = invite?.code
    if (!code) {
      const { api } = await import('./server')
      code = (await api<{ code: string }>('/invite', {})).code
    }
    const url = `${location.origin}/?invite=${code}`
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2500) } catch { prompt('Invite link', url) }
  }
  return (
    <>
      <div className="group membrane">
        <div className="cell"><span className="k">BLOOM</span><span className="v num bloom">{fmtNum(me.bloom)}</span></div>
        <div className="cell"><span className="k">eENERGY</span><span className="v num">{fmtNum(me.eEnergy)}</span></div>
      </div>

      {traits.length > 0 && (
        <>
          <div className="section-title">Mutations</div>
          <div className="group membrane">
            {traits.map(m => {
              const on = me.activated.includes(m)
              return (
                <div key={m} className="cell">
                  <span className="k">{mutationName(m)}</span>
                  {on ? <span className="v">Active</span> : (
                    <button className="pill-btn cell-quiet" disabled={busy || me.bloom < me.costs.activate} onClick={() => game({ type: 'activate', mutation: m })}>
                      Activate · {fmtNum(me.costs.activate)}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}

      {(Object.keys(s.sinks) as SinkKind[]).some(k => s.sinks[k]) && (
        <>
          <div className="section-title">Abilities</div>
          <div className="group membrane">
            {(Object.keys(s.sinks) as SinkKind[]).filter(k => s.sinks[k]).map(k => (
              <div key={k} className="cell">
                <span className="k">{SINK_WORD[k]}</span>
                {me.sinks.includes(k) ? <span className="v">Active</span> : (
                  <button className="pill-btn cell-quiet" disabled={busy || me.bloom < me.costs.activate} onClick={() => game({ type: 'activateSink', sink: k })}>
                    Activate · {fmtNum(me.costs.activate)}
                  </button>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      <div className="section-title">&nbsp;</div>
      <div className="group membrane">
        <button className="cell" onClick={share}><span className="k">{copied ? 'Link copied' : 'Invite a player'}</span></button>
        <button className="cell" onClick={onSignOut}><span className="k dim">Sign out</span></button>
      </div>
    </>
  )
}

// ---------------------------------------------------------------- one specimen (specimen tab)
function SpecimenGame({ spec, view, me, busy, serverOf, game, colorsOf }: Props) {
  const sid = spec === undefined ? undefined : serverOf(spec)
  const sp = view.specs.find(x => x.id === sid)
  const [name, setName] = useState('')
  const [steerOpen, setSteerOpen] = useState(false)
  useEffect(() => { setName(''); setSteerOpen(false) }, [sid])
  if (!sp || sid === undefined) return null
  const s = view.summary
  const mine = (me.placed[sid] ?? 0) > 0
  const traits = Object.keys(s.objective.traits).map(Number)
  const active = me.activated.filter(m => traits.includes(m))
  const has = (k: SinkKind) => me.sinks.includes(k) && s.sinks[k]
  const nameOk = new RegExp(s.rules.nameRule).test(name)
  const others = view.specs.filter(x => x.id !== sid).sort((a, b) => b.mass - a.mass).slice(0, 12)
  const localOf = (x: number) => { for (let i = 0; i < 1e5; i++) if (serverOf(i) === x) return i; return undefined }
  if (!sp.shown.length && !sp.expressed.length && !active.length && !(mine && (has('name') || has('color') || has('steer')))) return null
  return (
    <>
      {(sp.shown.length > 0 || sp.expressed.length > 0 || active.length > 0) && (
        <>
          <div className="section-title">Mutations</div>
          <div className="group membrane">
            {sp.shown.map(m => <div key={`s${m}`} className="cell"><span className="k">{mutationName(m)}</span><span className="v gold">Showing</span></div>)}
            {sp.expressed.map(m => <div key={`e${m}`} className="cell"><span className="k">{mutationName(m)}</span><span className="v">Evolving</span></div>)}
            {active.filter(m => !sp.shown.includes(m) && !sp.expressed.includes(m)).map(m => (
              <div key={`a${m}`} className="cell">
                <span className="k">{mutationName(m)}</span>
                <button className="pill-btn cell-quiet" disabled={busy || me.bloom < (me.costs.express[m] ?? Infinity)} onClick={() => game({ type: 'express', mutation: m, spec: sid })}>
                  Express · {fmtNum(me.costs.express[m] ?? 0)}
                </button>
              </div>
            ))}
          </div>
        </>
      )}
      {mine && (has('name') || has('color') || has('steer')) && (
        <>
          <div className="section-title">Abilities</div>
          <div className="group membrane">
            {has('name') && (
              <div className="cell">
                <input className="name-in" value={name} maxLength={16} placeholder="Name" onChange={e => setName(e.target.value)} />
                <button className="pill-btn cell-quiet" disabled={busy || !nameOk || me.bloom < me.costs.sinks.name} onClick={() => game({ type: 'useSink', sink: 'name', spec: sid, value: name })}>
                  {fmtNum(me.costs.sinks.name)}
                </button>
              </div>
            )}
            {has('color') && (
              <div className="cell swatches">
                {SPECIES.slice(0, s.rules.colors).map((c, i) => (
                  <button key={i} className={i === sp.color ? 'sw on' : 'sw'} aria-label={c.name} disabled={busy || i === sp.color || me.bloom < me.costs.sinks.color}
                    onClick={() => game({ type: 'useSink', sink: 'color', spec: sid, value: i })}>
                    <Orb colors={c} size={20} />
                  </button>
                ))}
                <span className="v">{fmtNum(me.costs.sinks.color)}</span>
              </div>
            )}
            {has('steer') && (
              <button className="cell" onClick={() => setSteerOpen(o => !o)}>
                <span className="k">Steer a loan{sp.steer !== null ? ` → ${nameOf(localOf(sp.steer) ?? 0)}` : ''}</span>
                <span className="v">{fmtNum(me.costs.sinks.steer)}</span>
              </button>
            )}
            {has('steer') && steerOpen && others.map(o => {
              const lid = localOf(o.id)
              return (
                <button key={o.id} className="cell" disabled={busy || me.bloom < me.costs.sinks.steer}
                  onClick={() => { setSteerOpen(false); game({ type: 'useSink', sink: 'steer', spec: sid, value: o.id }) }}>
                  <Orb colors={lid !== undefined ? colorsOf(lid) : undefined} size={16} />
                  <span className="k name">{lid !== undefined ? nameOf(lid) : o.id}</span>
                </button>
              )
            })}
          </div>
        </>
      )}
    </>
  )
}

// ---------------------------------------------------------------- sign in
export function SignIn({ invite, onSignUp, onSignIn, onTest }: {
  invite: string | null
  onSignUp: () => void
  onSignIn: () => void
  onTest?: (name: string) => void
}) {
  const [name, setName] = useState(() => `tester${Math.floor(Math.random() * 900 + 100)}`)
  const passkeys = typeof window.PublicKeyCredential === 'function' && window.isSecureContext
  return (
    <div className="signin glass membrane" role="dialog" aria-label="Sign in">
      <div className="guide-title">Superorganism</div>
      <div className="guide-body">{invite ? 'You were invited.' : 'One colony. Everyone feeds it.'}</div>
      <div className="signin-buttons">
        {passkeys ? (
          <>
            <button className="btn cell-btn" onClick={onSignUp}>Join</button>
            <button className="btn cell-quiet" onClick={onSignIn}>I have a passkey</button>
          </>
        ) : <div className="guide-body dim">Passkeys need a secure address.</div>}
        {onTest && (
          <div className="test-join">
            <input value={name} onChange={e => setName(e.target.value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 20))} aria-label="Test player name" />
            <button className="text-btn" onClick={() => onTest(name)}>Join as test player</button>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- Bloom moment (placeholder)
export function BloomFlash({ bloom, onDone }: { bloom: { key: number; mine: number } | null; onDone: () => void }) {
  useEffect(() => {
    if (!bloom) return
    const timer = window.setTimeout(onDone, 5200)
    return () => clearTimeout(timer)
  }, [bloom, onDone])
  if (!bloom) return null
  return (
    <div className="bloom-flash" key={bloom.key} aria-live="polite">
      <div className="bloom-word">Bloom</div>
      {bloom.mine > 0 && <div className="bloom-mine">+{fmtNum(bloom.mine)} BLOOM</div>}
    </div>
  )
}

// ---------------------------------------------------------------- demo controls (local dev only)
const SPEEDS = [1, 60, 600, 3600]
export function DemoControls({ summary, say }: { summary: Summary; say: (s: string) => void }) {
  const [open, setOpen] = useState(false)
  if (!ADMIN) return null
  const call = (path: string, body: unknown) => admin(path, body).catch(e => say(String(e.message ?? e)))
  if (!open) return <button className="dials-open glass membrane cell-quiet" aria-label="Demo controls" onClick={() => setOpen(true)}>⚙︎</button>
  return (
    <div className="dials glass membrane" role="group" aria-label="Demo controls">
      <div className="dials-title">
        <span>Demo controls <span className="sub">local only</span></span>
        <button className="close cell-quiet" aria-label="Close" onClick={() => setOpen(false)}>×</button>
      </div>
      <div className="dial-head"><span>Game speed</span><span className="num">{summary.speed}×</span></div>
      <div className="seg-row">
        {SPEEDS.map(x => <button key={x} className={summary.speed === x ? 'on' : ''} onClick={() => call('speed', { speed: x })}>{x === 1 ? 'Real' : x === 3600 ? '1 h/s' : `${x}×`}</button>)}
      </div>
      <div className="dial-head"><span>Activity bots</span><span className="num">{summary.bots}</span></div>
      <div className="seg-row">
        {[0, 10, 40, 100].map(x => <button key={x} className={summary.bots === x ? 'on' : ''} onClick={() => call('bots', { count: x })}>{x === 0 ? 'Off' : x}</button>)}
      </div>
      <div className="dial-foot">
        <button className="text-btn" onClick={() => { if (confirm('Reset the colony? Every account goes back to 1,000 ENERGY.')) call('reset', {}) }}>Reset colony</button>
        <button className="text-btn" onClick={() => testPlayer(`tester${Date.now() % 1000}`).then(() => location.reload())}>New test player</button>
      </div>
    </div>
  )
}
