// Play-money demo: talks to the game server (server/). No chain, no wallet. The server owns every
// rule and balance; this file only sends actions and turns the server's view into the shapes the
// field and menus already use (ChainNode, NetEvent, LoanLink), with amounts in 6-decimal units.
import { startAuthentication, startRegistration } from '@simplewebauthn/browser'
import type { Address } from 'viem'
import type { ChainNode, LoanLink, NetEvent } from '../chain'

export type Spec = {
  id: number; mass: number; depth: number; name: string | null; color: number
  shown: number[]; expressed: number[]; claims: Record<string, number>; steer: number | null
}
export type Loan = { lender: number; borrower: number; amt: number; end: number }
export type Summary = {
  t: number; now: number; realNow: number; speed: number; bots: number
  era: number; epoch: number; level: number; players: number; root: number
  objective: { nReq: number; qualifying: number; holdH: number; traits: Record<string, number>; short: Record<string, number>; kMin: number; empties: number; ok: boolean }
  holdSince: number | null; epochStart: number; deadline: number
  sinks: Record<SinkKind, boolean>; burnOpen: boolean
  rules: { divCap: number; divMid: number; objMin: number; colors: number; nameRule: string }
}
export type EpochResult = { era: number; epoch: number; bloomed: boolean; minted: number }
export type View = { summary: Summary; specs: Spec[]; tree: Record<string, number>; loans: Loan[]; history: EpochResult[] }
export type SinkKind = 'name' | 'color' | 'steer'
export type Me = {
  id: string; dEnergy: number; placed: Record<string, number>; stake: number; eEnergy: number; bloom: number; earned: number
  activated: number[]; sinks: SinkKind[]
  costs: { activate: number; express: Record<string, number>; sinks: Record<SinkKind, number> }
  invites: { code: string; used_by: string | null }[]
}
export type GameEvent = { t: number; type: string; [k: string]: unknown }
export type Message = ({ type: 'snapshot' } & View) | ({ type: 'events'; events: GameEvent[] } & View)

// ---------------------------------------------------------------- session
const TOKEN = 'superorganism.token'
export const token = () => { try { return localStorage.getItem(TOKEN) } catch { return null } }
const setToken = (t: string | null) => { try { if (t) localStorage.setItem(TOKEN, t); else localStorage.removeItem(TOKEN) } catch { /* private mode */ } }

export class ApiError extends Error { constructor(msg: string, public status: number) { super(msg) } }

export async function api<T = Record<string, unknown>>(path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const tk = token()
  const r = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(tk ? { authorization: `Bearer ${tk}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) {
    if (r.status === 401) setToken(null)
    throw new ApiError((data as { error?: string }).error ?? `error ${r.status}`, r.status)
  }
  return data as T
}

export async function signUp(invite?: string | null): Promise<Me> {
  const o = await api<{ flow: string; options: Parameters<typeof startRegistration>[0]['optionsJSON'] }>('/register/options', {})
  const response = await startRegistration({ optionsJSON: o.options })
  const r = await api<{ token: string; me: Me }>('/register/verify', { flow: o.flow, response, invite: invite ?? undefined })
  setToken(r.token)
  return r.me
}

export async function signIn(): Promise<Me> {
  const o = await api<{ flow: string; options: Parameters<typeof startAuthentication>[0]['optionsJSON'] }>('/login/options', {})
  const response = await startAuthentication({ optionsJSON: o.options })
  const r = await api<{ token: string; me: Me }>('/login/verify', { flow: o.flow, response })
  setToken(r.token)
  return r.me
}

export async function signOut() {
  try { await api('/logout', {}) } finally { setToken(null) }
}

export async function loadMe(): Promise<Me | null> {
  if (!token()) return null
  try { return (await api<{ me: Me }>('/me', {})).me } catch { return null }
}

export async function act(body: Record<string, unknown>): Promise<Me> {
  return (await api<{ me: Me }>('/action', body)).me
}

// ---------------------------------------------------------------- demo controls (local dev only)
export const ADMIN: string = typeof __DEMO_ADMIN__ === 'string' ? __DEMO_ADMIN__ : ''
export const admin = (path: string, body: unknown = {}) => api(`/admin/${path}`, body, { 'x-admin-key': ADMIN })

/** Local test player (no passkey): for phones on the Wi-Fi, where passkeys need https. */
export async function testPlayer(name: string): Promise<Me> {
  const r = await admin('bot', { id: name }) as { token: string }
  setToken(r.token)
  return (await api<{ me: Me }>('/me', {})).me
}

// ---------------------------------------------------------------- live updates
/** Opens the live socket and keeps it open. Returns a function that closes it. */
export function live(onMsg: (m: Message) => void, onLink: (up: boolean) => void): () => void {
  let ws: WebSocket | null = null
  let stopped = false
  let wait = 500
  const open = () => {
    if (stopped) return
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/live`)
    ws.onopen = () => { wait = 500; onLink(true) }
    ws.onmessage = e => { try { onMsg(JSON.parse(String(e.data))) } catch (err) { console.warn(err) } }
    ws.onclose = () => {
      onLink(false)
      if (!stopped) { setTimeout(open, wait); wait = Math.min(wait * 2, 8000) }
    }
  }
  open()
  return () => { stopped = true; ws?.close() }
}

// ---------------------------------------------------------------- server view -> field shapes
export const U = (x: number) => BigInt(Math.round(Math.max(0, x) * 1e6))

export type Board = {
  nodes: ChainNode[]
  links: LoanLink[]
  local: Map<number, number> // server id -> screen id
  server: number[] // screen id -> server id
  specs: Map<number, Spec> // screen id -> live specimen
  names: Map<number, string>
}

/** A loan's id that survives divisions (the server moves a loan to the first child). */
const loanKey = (end: number, amt: number) => {
  let h = 2166136261
  for (const c of `${end}:${amt.toFixed(9)}`) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) }
  return h >>> 0
}

export function divChance(s: Summary, mass: number) {
  if (mass <= 0) return 0
  const x = (mass / s.rules.divMid) ** 2
  return (s.rules.divCap * x) / (x + 1)
}

/** Real-time (ms) when a game time arrives, at the current speed. */
export const realAt = (s: Summary, game: number) => s.realNow + (game - s.now) / Math.max(1, s.speed)

export function board(v: View): Board {
  const ids = Object.keys(v.tree).map(Number).sort((a, b) => a - b)
  const local = new Map(ids.map((sid, i) => [sid, i]))
  const live = new Map(v.specs.map(s => [s.id, s]))
  const kids = new Map<number, number[]>()
  for (const sid of ids) {
    const p = v.tree[sid]
    if (p !== sid) kids.set(p, [...(kids.get(p) ?? []), sid])
  }
  const depthOf = (sid: number): number => { let d = 0; for (let x = sid; v.tree[x] !== x && d < 999; x = v.tree[x]) d++; return d }
  const lent = new Map<number, number>(), borrowed = new Map<number, number>()
  for (const l of v.loans) {
    lent.set(l.lender, (lent.get(l.lender) ?? 0) + l.amt)
    borrowed.set(l.borrower, (borrowed.get(l.borrower) ?? 0) + l.amt)
  }
  const specs = new Map<number, Spec>()
  const names = new Map<number, string>()
  const nodes: ChainNode[] = ids.map((sid, i) => {
    const s = live.get(sid)
    if (s) specs.set(i, s)
    if (s?.name) names.set(i, s.name)
    const ch = kids.get(sid) ?? []
    const total = s ? Object.values(s.claims).reduce((a, b) => a + b, 0) : 0
    return {
      id: i,
      parent: local.get(v.tree[sid]) ?? i,
      firstChild: ch.length ? local.get(Math.min(...ch))! : 0,
      depth: s?.depth ?? depthOf(sid),
      split: !s && ch.length > 0,
      gone: !s && ch.length === 0,
      total: U(total),
      traits: { feePpm: 0, rollCapPpm: 0, rollMidFill: U(v.summary.rules.divMid) },
      loanRules: { eventChancePpm: 0, loanMinSecs: 0, loanMaxSecs: 0, loansOutCap: 0 },
      lent: U(lent.get(sid) ?? 0),
      borrowed: U(borrowed.get(sid) ?? 0),
      energy: U(s?.mass ?? 0),
      rollFill: U(s?.mass ?? 0),
      sp: s ? s.color : undefined,
    }
  })
  const links: LoanLink[] = v.loans.flatMap(l => {
    const a = local.get(l.lender), b = local.get(l.borrower)
    if (a === undefined || b === undefined) return []
    return [{ loanId: loanKey(l.end, l.amt), lender: a, holder: b, amount: U(l.amt), due: realAt(v.summary, l.end) / 1000 }]
  })
  return { nodes, links, local, server: ids, specs, names }
}

let seq = 0
/** Server events as the field's events (feeds = deposits, draws = withdrawals, divisions = splits). */
export function netEvents(events: GameEvent[], b: Board, s: Summary): NetEvent[] {
  const out: NetEvent[] = []
  const L = (x: unknown) => b.local.get(Number(x))
  for (const e of events) {
    const key = `${e.t}:${seq++}`
    const block = 0n
    if (e.type === 'feed' || e.type === 'draw') {
      const node = L(e.spec)
      if (node === undefined) continue
      out.push({ kind: e.type === 'feed' ? 'deposit' : 'withdraw', node, user: String(e.player) as Address, amount: U(Number(e.amount)), key, block })
    } else if (e.type === 'divide') {
      const [k0, k1] = e.kids as [number, number]
      const parent = L(e.spec), c0 = L(k0), c1 = L(k1)
      if (parent === undefined || c0 === undefined || c1 === undefined) continue
      out.push({ kind: 'split', parent, c0, c1, key, block })
    } else if (e.type === 'loan') {
      const lender = L(e.lender), borrower = L(e.borrower)
      if (lender === undefined || borrower === undefined) continue
      out.push({ kind: 'loan', loanId: loanKey(Number(e.end), Number(e.amount)), lender, borrower, amount: U(Number(e.amount)), due: realAt(s, Number(e.end)) / 1000, key, block })
    } else if (e.type === 'repay') {
      const lender = L(e.lender)
      if (lender === undefined) continue
      out.push({ kind: 'repay', loanId: 0, lender, key, block })
    }
  }
  return out
}

/** Placeholder mutation names: era n's types are n0..n3, shown as A to D. */
export const mutationName = (m: number) => `Mutation ${'ABCD'[m % 10] ?? m % 10}`
export const fmtNum = (x: number) => x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
