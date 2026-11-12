// Game rules engine. Pure and deterministic: same seed + same actions at the same times = same state.
// The server owns one State, applies player actions with their game time, and calls tick() on a timer.
// All values serialize to JSON (plain objects and arrays only).
//
// Money-side rule: a player's dENERGY = granted - (sum placed). Placing and drawing only move dENERGY
// between the player's balance and their claims. Game mechanics (loans, divisions, dissipation) change
// specimen mass, never claims, so a draw always returns the full claim.

import { VALUES, type Values } from './values.ts'

export const H = 3_600_000
const YEAR = 365 * 24 * H
const EPS = 1e-9

export interface Spec {
  id: number
  mass: number
  claims: Record<string, number>
  expressed: number[]
  shown: number[]
  miss: Record<string, number>
  depth: number
}

export interface Player {
  id: string
  granted: number
  dEnergy: number
  placed: Record<string, number>
  stake: number
  eEnergy: number
  bloom: number
  earned: number
  spent: number
  activated: number[]
  expK: Record<string, number>
  wSum: number
  hrs: number
  lastT: number
  fedEpochs: number[]
  referrer: string | null
  referralPaid: boolean
  joined: number
}

export interface Loan { lender: number; borrower: number; amt: number; end: number }

export type GameEvent =
  | { t: number; type: 'join'; player: string }
  | { t: number; type: 'referral'; player: string; from: string; amount: number }
  | { t: number; type: 'feed'; player: string; spec: number; amount: number }
  | { t: number; type: 'draw'; player: string; spec: number; amount: number }
  | { t: number; type: 'divide'; spec: number; kids: [number, number] }
  | { t: number; type: 'loan'; lender: number; borrower: number; amount: number; end: number }
  | { t: number; type: 'repay'; lender: number; borrower: number; amount: number }
  | { t: number; type: 'gone'; spec: number }
  | { t: number; type: 'show'; spec: number; mutation: number }
  | { t: number; type: 'activate'; player: string; mutation: number; cost: number }
  | { t: number; type: 'express'; player: string; mutation: number; spec: number; cost: number }
  | { t: number; type: 'burn'; player: string; amount: number }
  | { t: number; type: 'bloom'; era: number; epoch: number; minted: number; treasury: number; shares: Record<string, number> }
  | { t: number; type: 'fail'; era: number; epoch: number }
  | { t: number; type: 'epoch'; era: number; epoch: number; level: number }

export interface EpochResult {
  era: number
  epoch: number
  level: number
  bloomed: boolean
  lengthH: number
  targetH: number
  minted: number
  specimens: number
  players: number
}

export interface State {
  v: Values
  rng: number
  t: number
  era: number
  epoch: number
  g: number
  level: number
  epochStart: number
  nextCheck: number
  holdSince: number | null
  specs: Record<string, Spec>
  nextId: number
  loans: Loan[]
  players: Record<string, Player>
  released: number
  playerReleased: number
  treasury: number
  burned: number
  volBurned: number
  eraEmitted: number[]
  burnOpen: boolean
  history: EpochResult[]
  events: GameEvent[]
}

export interface Objective { nReq: number; holdH: number; traits: Record<string, number> }
export interface Status extends Objective { ok: boolean; qualifying: number; short: Record<string, number>; kMin: number; empties: number }

export class RuleError extends Error {}

// ------------------------------------------------------------------ random (mulberry32, state in State)
export function rand(st: State): number {
  const a = (st.rng = (st.rng + 0x6d2b79f5) | 0)
  let t = Math.imul(a ^ (a >>> 15), 1 | a)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const uniform = (st: State, lo: number, hi: number) => lo + (hi - lo) * rand(st)

// ------------------------------------------------------------------ create
export function create(seed: number, t0: number, v: Values = VALUES): State {
  const st: State = {
    v, rng: seed | 0, t: t0, era: 0, epoch: 0, g: 0, level: 0, epochStart: t0, nextCheck: t0, holdSince: null,
    specs: {}, nextId: 0, loans: [], players: {}, released: 0, playerReleased: 0, treasury: 0, burned: 0,
    volBurned: 0, eraEmitted: [0], burnOpen: false, history: [], events: [],
  }
  startEpoch(st)
  return st
}

function newSpec(st: State, depth = 0): Spec {
  const s: Spec = { id: st.nextId++, mass: 0, claims: {}, expressed: [], shown: [], miss: {}, depth }
  st.specs[s.id] = s
  return s
}

function startEpoch(st: State) {
  st.specs = {}
  st.loans = []
  newSpec(st)
  for (const p of Object.values(st.players)) {
    p.expK = {}
    p.wSum = 0
    p.hrs = 0
    p.lastT = st.t
  }
  const o = objective(st)
  const traitCount = Object.values(o.traits).reduce((a, b) => a + b, 0)
  const nTypes = Object.keys(o.traits).length
  const cm = costMult(st)
  const need = nTypes ? (traitCount * st.v.express + nTypes * st.v.activate) * cm : st.v.activate * cm
  const circ = Object.values(st.players).reduce((a, p) => a + p.bloom, 0)
  st.burnOpen = circ >= st.v.burnGate * need
  st.epochStart = st.t
  st.nextCheck = st.t + st.v.bloomCheckMin * 60_000
  st.holdSince = null
  st.events.push({ t: st.t, type: 'epoch', era: st.era, epoch: st.epoch, level: st.level })
}

// ------------------------------------------------------------------ rules
export function costMult(st: State): number {
  return 1 + st.v.costRise * Math.max(0, st.g - 3)
}

export function eraTotal(st: State): number {
  return st.v.era1Bloom * (st.era + 1)
}

export function epochMint(st: State, epoch = st.epoch): number {
  const k = st.v.emitK
  let sum = 0
  for (let i = 1; i <= st.v.eraEpochs; i++) sum += i ** k
  return (eraTotal(st) * (epoch + 1) ** k) / sum
}

export function divChance(v: Values, m: number): number {
  if (m <= 0) return 0
  const x = (m / v.divMid) ** 2
  return (v.divCap * x) / (x + 1)
}

export function objective(st: State): Objective {
  const v = st.v
  const lvl = st.level
  const nReq = Math.round(v.objStart * v.objGrowth ** lvl)
  const holdH = v.holdStartH + v.holdAddH * lvl
  const traits: Record<string, number> = {}
  const mutStart = st.era === 0 ? v.mutStartEra1 : 0
  if (lvl >= mutStart && v.traitShare > 0 && st.released > 0) {
    const step = lvl - mutStart
    const nTypes = Math.min(1 + Math.floor(step / v.typesEvery), v.maxTypes)
    const share = Math.min(v.traitShare * v.traitGrowth ** step, 1)
    for (let j = 0; j < nTypes; j++) traits[st.era * 10 + j] = Math.ceil(share * nReq)
  }
  return { nReq, holdH, traits }
}

export function status(st: State): Status {
  const v = st.v
  const o = objective(st)
  const live = Object.values(st.specs)
  const q = live.filter((s) => s.mass >= v.objMin)
  const short: Record<string, number> = {}
  for (const [m, need] of Object.entries(o.traits)) {
    const have = q.filter((s) => s.shown.includes(Number(m))).length
    if (need - have > 0) short[m] = need - have
  }
  const kStart = st.era === 0 ? v.kStartEra1 : 0
  const kMin = v.kMin * v.kGrowth ** Math.max(0, st.epoch - kStart)
  const empties = st.epoch < kStart ? 0 : live.filter((s) => s.mass < kMin).length
  const ok = q.length >= o.nReq && Object.keys(short).length === 0 && empties === 0
  return { ...o, ok, qualifying: q.length, short, kMin, empties }
}

export function treasuryShare(st: State): number {
  let steps = 0
  let need = 0
  if (st.eraEmitted.length > 1) {
    for (const e of st.eraEmitted.slice(0, -1)) {
      need += e
      if (st.volBurned >= need && e > 0) steps++
    }
  }
  return Math.max(st.v.treasury0 - st.v.treasuryStep * steps, st.v.treasuryFloor)
}

// ------------------------------------------------------------------ helpers
function player(st: State, id: string): Player {
  const p = st.players[id]
  if (!p) throw new RuleError('unknown player')
  return p
}

function liveSpec(st: State, sid: number): Spec {
  const s = st.specs[sid]
  if (!s) throw new RuleError('specimen not in the colony')
  return s
}

function amountOk(a: number) {
  if (!Number.isFinite(a) || a <= 0) throw new RuleError('bad amount')
}

/** Bring a player's weight, hours and eENERGY up to st.t. Call before any stake change. */
function accrue(st: State, p: Player) {
  const dt = st.t - p.lastT
  if (dt > 0 && p.stake > 0) {
    p.hrs += dt / H
    p.wSum += (p.stake * dt) / H
    p.eEnergy += (p.stake * st.v.eRatePerYear * dt) / YEAR
  }
  p.lastT = st.t
}

function rollShow(st: State, s: Spec) {
  for (const m of [...s.expressed]) {
    const misses = s.miss[m] ?? 0
    const ch = Math.min(st.v.show0 * (1 + misses), st.v.showCeil)
    if (rand(st) < ch) {
      s.shown.push(m)
      s.expressed = s.expressed.filter((x) => x !== m)
      delete s.miss[m]
      st.events.push({ t: st.t, type: 'show', spec: s.id, mutation: m })
    } else {
      s.miss[m] = misses + 1
    }
  }
}

function divide(st: State, s: Spec) {
  rollShow(st, s)
  delete st.specs[s.id]
  const kids = [newSpec(st, s.depth + 1), newSpec(st, s.depth + 1)] as const
  for (const c of kids) {
    c.mass = s.mass / 2
    for (const [pid, a] of Object.entries(s.claims)) c.claims[pid] = a / 2
    c.shown = [...s.shown]
    c.expressed = [...s.expressed]
    c.miss = { ...s.miss }
  }
  for (const l of st.loans) {
    if (l.lender === s.id) l.lender = kids[0].id
    if (l.borrower === s.id) l.borrower = kids[0].id
  }
  for (const pid of Object.keys(s.claims)) {
    const p = st.players[pid]
    const amt = p?.placed[s.id]
    if (!p || amt === undefined) continue
    delete p.placed[s.id]
    p.placed[kids[0].id] = (p.placed[kids[0].id] ?? 0) + amt / 2
    p.placed[kids[1].id] = (p.placed[kids[1].id] ?? 0) + amt / 2
  }
  st.events.push({ t: st.t, type: 'divide', spec: s.id, kids: [kids[0].id, kids[1].id] })
}

function loan(st: State, lender: Spec) {
  const ids = Object.keys(st.specs)
  if (ids.length < 2) return
  const b = st.specs[ids[Math.floor(rand(st) * ids.length)]]
  if (b === lender) return
  const amt = lender.mass * uniform(st, st.v.loanShareMin, st.v.loanShareMax)
  lender.mass -= amt
  b.mass += amt
  const end = st.t + uniform(st, st.v.loanMinH, st.v.loanMaxH) * H
  st.loans.push({ lender: lender.id, borrower: b.id, amt, end })
  st.events.push({ t: st.t, type: 'loan', lender: lender.id, borrower: b.id, amount: amt, end })
  rollShow(st, lender)
  rollShow(st, b)
}

function repayDue(st: State) {
  const keep: Loan[] = []
  for (const l of st.loans) {
    if (l.end > st.t) { keep.push(l); continue }
    const sl = st.specs[l.lender]
    const sb = st.specs[l.borrower]
    if (sb) sb.mass = Math.max(0, sb.mass - l.amt)
    if (sl) sl.mass += l.amt
    st.events.push({ t: st.t, type: 'repay', lender: l.lender, borrower: l.borrower, amount: l.amt })
    for (const s of [sl, sb]) if (s) rollShow(st, s)
  }
  st.loans = keep
}

/** An empty specimen with no active loan leaves the colony; never the last one. Claims stay drawable. */
function dissipate(st: State) {
  const busy = new Set<number>()
  for (const l of st.loans) { busy.add(l.lender); busy.add(l.borrower) }
  for (const s of Object.values(st.specs)) {
    if (s.mass <= st.v.empty && !busy.has(s.id) && Object.keys(st.specs).length > 1) {
      delete st.specs[s.id]
      st.events.push({ t: st.t, type: 'gone', spec: s.id })
    }
  }
}

function endEpoch(st: State, bloomed: boolean) {
  const v = st.v
  const players = Object.values(st.players)
  for (const p of players) accrue(st, p)
  const active = players.filter((p) => p.stake > 0)
  let minted = 0
  if (bloomed && active.length) {
    minted = epochMint(st)
    const toT = minted * treasuryShare(st)
    const pool = minted - toT
    const w = active.map((p) => {
      const h = Math.max(p.hrs, EPS)
      return (p.wSum / h) * h ** v.wTime
    })
    const wsum = w.reduce((a, b) => a + b, 0)
    const shares: Record<string, number> = {}
    active.forEach((p, i) => {
      const x = (pool * w[i]) / wsum
      p.bloom += x
      p.earned += x
      shares[p.id] = x
    })
    st.treasury += toT
    st.released += minted
    st.playerReleased += pool
    st.eraEmitted[st.era] += minted
    st.events.push({ t: st.t, type: 'bloom', era: st.era, epoch: st.epoch, minted, treasury: toT, shares })
  } else {
    bloomed = false
    st.events.push({ t: st.t, type: 'fail', era: st.era, epoch: st.epoch })
  }
  st.history.push({
    era: st.era, epoch: st.epoch, level: st.level, bloomed, lengthH: (st.t - st.epochStart) / H,
    targetH: v.targetHours[st.epoch], minted, specimens: Object.keys(st.specs).length, players: players.length,
  })
  // every epoch ends with all placed dENERGY back in players' balances
  for (const p of players) {
    p.dEnergy += p.stake
    p.stake = 0
    p.placed = {}
  }
  st.level = bloomed ? st.level + 1 : Math.max(st.level - 1, 0)
  st.g++
  st.epoch++
  if (st.epoch >= v.eraEpochs) {
    st.era++
    st.epoch = 0
    st.level = 0
    st.eraEmitted.push(0)
  }
  startEpoch(st)
}

// ------------------------------------------------------------------ time
/** Advance game time to `now`: loan repayments, 5-minute Bloom checks, epoch deadline. */
export function tick(st: State, now: number) {
  const v = st.v
  const checkMs = v.bloomCheckMin * 60_000
  for (;;) {
    const deadline = st.epochStart + v.targetHours[st.epoch] * v.failFactor * H
    let nextLoan = Infinity
    for (const l of st.loans) if (l.end < nextLoan) nextLoan = l.end
    const next = Math.min(st.nextCheck, deadline, nextLoan)
    if (next > now) break
    st.t = Math.max(st.t, next)
    if (nextLoan <= next) {
      repayDue(st)
      dissipate(st)
      continue
    }
    if (deadline <= st.nextCheck) {
      endEpoch(st, false)
      continue
    }
    dissipate(st)
    const s = status(st)
    if (!s.ok) st.holdSince = null
    else if (st.holdSince === null) st.holdSince = st.t
    st.nextCheck += checkMs
    const held = st.holdSince === null ? 0 : (st.t - st.holdSince) / H
    if (s.ok && held >= Math.max(s.holdH, v.windowH) && rand(st) < v.bloomCheckP) endEpoch(st, true)
  }
  st.t = Math.max(st.t, now)
}

// ------------------------------------------------------------------ player actions
export function join(st: State, id: string, now: number, referrer?: string) {
  tick(st, now)
  if (!id || st.players[id]) throw new RuleError('player exists')
  const ref = referrer && referrer !== id && st.players[referrer] ? referrer : null
  st.players[id] = {
    id, granted: st.v.signup, dEnergy: st.v.signup, placed: {}, stake: 0, eEnergy: 0, bloom: 0, earned: 0,
    spent: 0, activated: [], expK: {}, wSum: 0, hrs: 0, lastT: st.t, fedEpochs: [], referrer: ref,
    referralPaid: false, joined: st.t,
  }
  st.events.push({ t: st.t, type: 'join', player: id })
}

export function feed(st: State, id: string, sid: number, amount: number, now: number) {
  tick(st, now)
  amountOk(amount)
  const p = player(st, id)
  const s = liveSpec(st, sid)
  if (amount > p.dEnergy + EPS) throw new RuleError('not enough dENERGY')
  const a = Math.min(amount, p.dEnergy)
  accrue(st, p)
  p.dEnergy -= a
  p.stake += a
  p.placed[sid] = (p.placed[sid] ?? 0) + a
  s.mass += a
  s.claims[id] = (s.claims[id] ?? 0) + a
  if (!p.fedEpochs.includes(st.g)) p.fedEpochs.push(st.g)
  st.events.push({ t: st.t, type: 'feed', player: id, spec: sid, amount: a })
  // referral: the inviter earns once, when the invited player first feeds
  if (p.referrer && !p.referralPaid) {
    const r = st.players[p.referrer]
    p.referralPaid = true
    if (r) {
      r.dEnergy += st.v.referral
      r.granted += st.v.referral
      st.events.push({ t: st.t, type: 'referral', player: r.id, from: id, amount: st.v.referral })
    }
  }
  if (rand(st) < st.v.loanChance) loan(st, s)
  const rolls = s.mass >= st.v.secondRollAt ? 2 : 1
  for (let i = 0; i < rolls; i++) {
    if (st.specs[s.id] && rand(st) < divChance(st.v, s.mass)) { divide(st, s); break }
  }
}

/** Draw from one placement. Returns the full claim requested, whatever the specimen's mass or state. */
export function draw(st: State, id: string, sid: number, amount: number, now: number) {
  tick(st, now)
  amountOk(amount)
  const p = player(st, id)
  const have = p.placed[sid]
  if (have === undefined) throw new RuleError('nothing placed there')
  const take = Math.min(amount, have)
  accrue(st, p)
  if (have - take <= EPS) delete p.placed[sid]
  else p.placed[sid] = have - take
  p.stake = Math.max(0, p.stake - take)
  p.dEnergy += take
  const s = st.specs[sid]
  if (s) {
    s.mass = Math.max(0, s.mass - take)
    const c = (s.claims[id] ?? 0) - take
    if (c <= EPS) delete s.claims[id]
    else s.claims[id] = c
  }
  st.events.push({ t: st.t, type: 'draw', player: id, spec: sid, amount: take })
  dissipate(st)
}

export function drawAll(st: State, id: string, now: number) {
  const p = player(st, id)
  for (const [sid, amt] of Object.entries(p.placed)) draw(st, id, Number(sid), amt, now)
}

function mutationAllowed(st: State, m: number) {
  return Number.isInteger(m) && Math.floor(m / 10) === st.era && m % 10 < st.v.maxTypes
}

export function activateCost(st: State) { return st.v.activate * costMult(st) }
export function expressCost(st: State, id: string, m: number) {
  const n = st.players[id]?.expK[m] ?? 0
  return st.v.express * st.v.expressGrowth ** n * costMult(st)
}

export function activate(st: State, id: string, m: number, now: number) {
  tick(st, now)
  const p = player(st, id)
  if (!mutationAllowed(st, m)) throw new RuleError('mutation not in this era')
  if (p.activated.includes(m)) throw new RuleError('already active')
  const cost = activateCost(st)
  if (p.bloom + EPS < cost) throw new RuleError('not enough BLOOM')
  p.bloom = Math.max(0, p.bloom - cost)
  p.spent += cost
  st.burned += cost
  p.activated.push(m)
  st.events.push({ t: st.t, type: 'activate', player: id, mutation: m, cost })
}

export function express(st: State, id: string, m: number, sid: number, now: number) {
  tick(st, now)
  const p = player(st, id)
  if (!p.activated.includes(m)) throw new RuleError('not active')
  const s = liveSpec(st, sid)
  if (s.shown.includes(m) || s.expressed.includes(m)) throw new RuleError('already expressed')
  const cost = expressCost(st, id, m)
  if (p.bloom + EPS < cost) throw new RuleError('not enough BLOOM')
  p.bloom = Math.max(0, p.bloom - cost)
  p.spent += cost
  st.burned += cost
  p.expK[m] = (p.expK[m] ?? 0) + 1
  s.expressed.push(m)
  st.events.push({ t: st.t, type: 'express', player: id, mutation: m, spec: sid, cost })
}

export function burn(st: State, id: string, amount: number, now: number) {
  tick(st, now)
  amountOk(amount)
  const p = player(st, id)
  if (!st.burnOpen) throw new RuleError('burn closed')
  if (amount > p.bloom + EPS) throw new RuleError('not enough BLOOM')
  const a = Math.min(amount, p.bloom)
  p.bloom -= a
  p.spent += a
  st.burned += a
  st.volBurned += a
  st.events.push({ t: st.t, type: 'burn', player: id, amount: a })
}

// ------------------------------------------------------------------ checks
/** Throws if any conservation rule is broken. Cheap enough to run after every action in tests. */
export function check(st: State) {
  const close = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b))
  let bloomHeld = 0
  for (const p of Object.values(st.players)) {
    if (p.dEnergy < -EPS || p.stake < -EPS || p.bloom < -EPS) throw new Error(`negative balance ${p.id}`)
    const placed = Object.values(p.placed).reduce((a, b) => a + b, 0)
    if (!close(placed, p.stake)) throw new Error(`stake != placed for ${p.id}`)
    if (!close(p.dEnergy + p.stake, p.granted)) throw new Error(`dENERGY not conserved for ${p.id}`)
    for (const [sid, amt] of Object.entries(p.placed)) {
      const s = st.specs[sid]
      if (s && !close(s.claims[p.id] ?? 0, amt)) throw new Error(`claim mismatch ${p.id} on ${sid}`)
    }
    bloomHeld += p.bloom
  }
  for (const s of Object.values(st.specs)) {
    for (const [pid, c] of Object.entries(s.claims)) {
      if (!close(st.players[pid]?.placed[s.id] ?? 0, c)) throw new Error(`orphan claim ${pid} on ${s.id}`)
    }
  }
  if (!close(st.released, st.playerReleased + st.treasury)) throw new Error('BLOOM minted != players + treasury')
  if (!close(bloomHeld + st.burned, st.playerReleased)) throw new Error('player BLOOM not conserved')
}
