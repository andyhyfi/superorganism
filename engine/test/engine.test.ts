// Engine tests. Run: npm test (in engine/)
import fs from 'node:fs'
import {
  create, join, feed, draw, drawAll, activate, express, burn, tick, check, status, objective, epochMint,
  divChance, expressCost, activateCost, activateSink, useSink, sinkCost, RuleError, H, type State,
} from '../src/engine.ts'
import { VALUES } from '../src/values.ts'

let n = 0
function ok(c: unknown, what: string) {
  if (!c) { console.error(`FAIL ${what}`); process.exit(1) }
  n++
}
const close = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b))
function throws(f: () => void, msg: string, what: string) {
  try { f() } catch (e) { ok(e instanceof RuleError && e.message === msg, `${what} (got ${(e as Error).message})`); return }
  ok(false, `${what} (no error)`)
}

// ---------------------------------------------------------------- parity with the simulator
const fx = JSON.parse(fs.readFileSync(new URL('./sim-parity.json', import.meta.url), 'utf8'))
{
  const st = create(1, 0)
  for (const o of fx.objectives) {
    st.era = o.era; st.level = o.level; st.released = o.released
    const got = objective(st)
    ok(got.nReq === o.nReq && got.holdH === o.hold && JSON.stringify(got.traits) === JSON.stringify(o.traits),
      `objective parity era ${o.era} level ${o.level} released ${o.released}`)
  }
  for (let era = 0; era < 3; era++) {
    st.era = era
    for (let e = 0; e < 10; e++) ok(close(epochMint(st, e), fx.emission[era][e]), `emission parity era ${era} epoch ${e}`)
  }
  for (const [m, p] of fx.div) ok(close(divChance(VALUES, m), p), `division chance parity at ${m}`)
}

// ---------------------------------------------------------------- easing objectives
{
  const st = create(1, 0)
  st.level = 4
  const full = objective(st).nReq
  st.scale = 0.5
  ok(objective(st).nReq === Math.round(full * 0.5), 'half the feeders: objectives ask about half')
  st.scale = 0.01
  st.level = 0
  ok(objective(st).nReq === VALUES.objStart, 'objectives never shrink below the starting size')
  // scale follows feeders against peak at epoch end
  const s2 = create(2, 0)
  for (let i = 0; i < 8; i++) { join(s2, `p${i}`, 0); feed(s2, `p${i}`, Number(Object.keys(s2.specs)[0]), 5, 0) }
  tick(s2, 48 * H + 1)
  ok(s2.peakFeeders === 8 && s2.scale === 1, 'peak feeders recorded, scale 1 at peak')
  feed(s2, 'p0', Number(Object.keys(s2.specs)[0]), 5, 48 * H + 2)
  feed(s2, 'p1', Number(Object.keys(s2.specs)[0]), 5, 48 * H + 3)
  tick(s2, 48 * H + 2 * VALUES.targetHours[1] * H + 10)
  ok(s2.history.length === 2 && s2.history[1].feeders === 2, 'second epoch had 2 feeders')
  ok(s2.scale === Math.max(VALUES.easeFloor, 2 / 8), 'scale = feeders / peak, with the floor')
  check(s2)
}

// ---------------------------------------------------------------- dENERGY rules
{
  const st = create(7, 0)
  join(st, 'a', 0)
  join(st, 'b', 0, 'a')
  ok(st.players.a.dEnergy === 1000 && st.players.b.dEnergy === 1000, 'sign-up grants 1,000 dENERGY')
  ok(st.players.a.dEnergy === 1000, 'no referral payment on join alone')
  throws(() => join(st, 'a', 0), 'player exists', 'one account per id')
  throws(() => feed(st, 'a', 0, 1001, 0), 'not enough dENERGY', 'cannot place more than held')
  throws(() => feed(st, 'a', 0, -5, 0), 'bad amount', 'negative amount refused')
  throws(() => feed(st, 'a', 0, NaN, 0), 'bad amount', 'NaN refused')
  throws(() => feed(st, 'a', 999, 10, 0), 'specimen not in the colony', 'unknown specimen refused')
  throws(() => feed(st, 'zz', 0, 10, 0), 'unknown player', 'unknown player refused')
  feed(st, 'b', 0, 50, 0)
  ok(st.players.a.dEnergy === 1500 && st.players.a.granted === 1500, 'inviter gets 500 when invited player feeds')
  const sid = Number(Object.keys(st.players.b.placed)[0])
  feed(st, 'b', sid, 50, 0)
  ok(st.players.a.dEnergy === 1500, 'referral pays once')
  check(st)
  // self-referral is refused
  join(st, 'c', 0, 'c')
  ok(st.players.c.referrer === null, 'self-referral ignored')
  // a player never draws more than placed, and never draws from others' placements
  throws(() => draw(st, 'a', sid, 10, 0), 'nothing placed there', 'cannot draw where nothing placed')
  const before = st.players.b.dEnergy + st.players.b.stake
  drawAll(st, 'b', 0)
  ok(st.players.b.stake === 0 && close(st.players.b.dEnergy, before), 'draw all returns every dENERGY placed')
  check(st)
}

// draw returns the full claim even after loans drained the specimen, divisions and dissipation
{
  const st = create(11, 0)
  for (let i = 0; i < 30; i++) join(st, `p${i}`, 0)
  let t = 0
  for (let k = 0; k < 4000; k++) {
    t += 60_000
    tick(st, t) // an epoch may end here and reset the colony
    const p = `p${k % 30}`
    const ids = Object.keys(st.specs).map(Number)
    const sid = ids[k % ids.length]
    const pl = st.players[p]
    if (k % 7 === 3 && Object.keys(pl.placed).length) {
      const [s0, a0] = Object.entries(pl.placed)[0]
      const want = a0
      const d0 = pl.dEnergy
      draw(st, p, Number(s0), want, t)
      ok(close(st.players[p].dEnergy - d0, want), 'draw pays exactly the claim')
    } else if (pl.dEnergy >= 5) {
      feed(st, p, sid, Math.min(pl.dEnergy, 5 + (k % 40)), t)
    }
    check(st)
  }
  ok(st.events.some((e) => e.type === 'divide'), 'divisions happened')
  ok(st.events.some((e) => e.type === 'loan') && st.events.some((e) => e.type === 'repay'), 'loans and repayments happened')
}

// ---------------------------------------------------------------- epochs and Bloom
{
  // nobody plays: epoch fails at 2x target, level stays 0, all dENERGY returned
  const st = create(3, 0)
  join(st, 'a', 0)
  feed(st, 'a', 0, 10, 0)
  tick(st, 48 * H + 1)
  ok(st.history.length === 1 && !st.history[0].bloomed, 'empty epoch fails at 2x its 24 h target')
  ok(st.players.a.dEnergy === 1000 && st.players.a.stake === 0, 'failed epoch returns all placed dENERGY')
  ok(st.level === 0 && st.epoch === 1, 'failed epoch moves to next epoch, level floor 0')
  check(st)
}
{
  // objectives met and held: Bloom follows within hours, BLOOM split among placed players
  const st = create(5, 0)
  for (let i = 0; i < 12; i++) join(st, `p${i}`, 0)
  let t = 0
  // grow 10 specimens >= 100 by feeding the smallest qualifying candidates
  for (let k = 0; k < 2000 && status(st).qualifying < 10; k++) {
    t += 60_000
    const p = `p${k % 12}`
    const below = Object.values(st.specs).filter((s) => s.mass < 100).sort((a, b) => b.mass - a.mass)
    const target = below[0] ?? Object.values(st.specs)[0]
    if (st.players[p].dEnergy > 30) feed(st, p, target.id, 30, t)
  }
  ok(status(st).qualifying >= 10, 'colony reaches 10 qualifying specimens')
  const startHold = t
  tick(st, t + 2.5 * H)
  ok(st.history.length === 0, 'no Bloom before the 3 h hold')
  tick(st, startHold + 12 * H)
  ok(st.history.length === 1 && st.history[0].bloomed, 'Bloom within hours once the hold is met (10% per 5 min)')
  const minted = st.history[0].minted
  ok(close(minted, fx.emission[0][0]), 'epoch 1 mints the agreed amount')
  ok(close(st.treasury, minted * 0.15), 'treasury takes 15%')
  const toPlayers = Object.values(st.players).reduce((a, p) => a + p.bloom, 0)
  ok(close(toPlayers, minted * 0.85), 'players get 85%')
  ok(st.level === 1 && st.epoch === 1, 'Bloom raises the level')
  check(st)
}

// ---------------------------------------------------------------- mutations and burns
{
  const st = create(9, 0)
  join(st, 'a', 0)
  feed(st, 'a', 0, 200, 0)
  throws(() => activate(st, 'a', 0, 0), 'not enough BLOOM', 'activate needs BLOOM')
  st.players.a.bloom = 100; st.players.a.earned = 100; st.playerReleased = 100; st.released = 100 / 0.85; st.treasury = st.released - 100
  throws(() => activate(st, 'a', 12, 0), 'mutation not in this era', 'only this era\'s mutations')
  activate(st, 'a', 0, 0)
  ok(close(st.players.a.bloom, 100 - activateCost(st)), 'activate burns its cost')
  throws(() => activate(st, 'a', 0, 0), 'already active', 'activate once per mutation')
  const sid = Number(Object.keys(st.specs)[0])
  const c1 = expressCost(st, 'a', 0)
  express(st, 'a', 0, sid, 0)
  ok(close(expressCost(st, 'a', 0), c1 * VALUES.expressGrowth), 'express cost rises per repeat')
  throws(() => express(st, 'a', 0, sid, 0), 'already expressed', 'one express per specimen per mutation')
  check(st)
  st.burnOpen = false
  throws(() => burn(st, 'a', 1, 0), 'burn closed', 'burn closed below the gate')
  st.burnOpen = true
  const b0 = st.players.a.bloom
  burn(st, 'a', 10, 0)
  ok(close(st.players.a.bloom, b0 - 10) && close(st.volBurned, 10), 'burn removes BLOOM')
  check(st)
}

// ---------------------------------------------------------------- eras 2+: easiest objectives need no mutation
{
  const st = create(1, 0)
  st.era = 1; st.released = 1
  st.level = 0
  ok(Object.keys(objective(st).traits).length === 0, 'era 2 easiest objectives: no mutation')
  st.level = 1
  ok(Object.keys(objective(st).traits).length === 1, 'era 2 second step: mutation objective')
}

// ---------------------------------------------------------------- optional sinks
{
  const st = create(17, 0)
  join(st, 'a', 0); join(st, 'b', 0)
  st.players.a.bloom = 200; st.players.a.earned = 200; st.players.b.bloom = 200; st.players.b.earned = 200
  st.playerReleased = 400; st.released = 400 / 0.85; st.treasury = st.released - 400
  throws(() => activateSink(st, 'a', 'name', 0), 'not open yet', 'name closed in era 1 epoch 1')
  st.epoch = 1
  activateSink(st, 'a', 'name', 0)
  activateSink(st, 'a', 'color', 0)
  throws(() => activateSink(st, 'a', 'steer', 0), 'not open yet', 'steer closed until era 1 epoch 3')
  throws(() => activateSink(st, 'a', 'name', 0), 'already active', 'sink activates once')
  ok(close(st.players.a.bloom, 200 - 2 * activateCost(st)), 'sink activation burns its cost')
  const s0 = Number(Object.keys(st.specs)[0])
  throws(() => useSink(st, 'a', 'name', s0, 'Mira', 0), 'feed it first', 'name only specimens you fed')
  feed(st, 'a', s0, 30, 0)
  const sid = Number(Object.keys(st.players.a.placed)[0])
  throws(() => useSink(st, 'a', 'name', sid, 'x', 0), 'bad name', 'name too short refused')
  throws(() => useSink(st, 'a', 'name', sid, 'has space', 0), 'bad name', 'name with space refused')
  throws(() => useSink(st, 'a', 'name', sid, 'theAdmin', 0), 'name not allowed', 'blocked word refused')
  const c1 = sinkCost(st, 'a', 'name')
  const b1 = st.players.a.bloom
  useSink(st, 'a', 'name', sid, 'Mira', 0)
  ok(st.specs[sid].name === 'Mira' && close(st.players.a.bloom, b1 - c1), 'name set, cost burned')
  ok(close(sinkCost(st, 'a', 'name'), c1 * VALUES.expressGrowth), 'next name costs more')
  // division: Mira, Mira-2
  const kids = (() => { for (let i = 0; i < 400 && st.specs[sid]; i++) feed(st, 'a', sid, 2, 0); return Object.values(st.specs).filter((x) => x.nameBase === 'Mira') })()
  ok(kids.length >= 2 && kids.some((k) => k.name === 'Mira') && kids.some((k) => k.name === 'Mira-2'), 'children inherit name: Mira, Mira-2')
  // uniqueness
  feed(st, 'b', s0 in st.specs ? s0 : kids[0].id, 5, 0)
  st.players.b.sinks.push('name')
  const other = Object.values(st.specs).find((x) => (x.claims.b ?? 0) > 0)!
  if (other.nameBase !== 'Mira') throws(() => useSink(st, 'b', 'name', other.id, 'mira', 0), 'name taken', 'names unique (any case)')
  // color
  const cs = kids[0].id
  useSink(st, 'a', 'color', cs, 3, 0)
  ok(st.specs[cs].color === 3, 'color set')
  throws(() => useSink(st, 'a', 'color', cs, 4, 0), 'recolored recently', 'recolor locked for 1 hour')
  throws(() => useSink(st, 'a', 'color', cs, 99, 0), 'bad color', 'color outside palette refused')
  check(st)
}
{
  // steer: next loan from the specimen goes to the chosen one
  const st = create(19, 0)
  join(st, 'a', 0)
  st.epoch = 2; st.players.a.bloom = 100; st.players.a.earned = 100; st.playerReleased = 100; st.released = 100 / 0.85; st.treasury = st.released - 100
  activateSink(st, 'a', 'steer', 0)
  const root = Number(Object.keys(st.specs)[0])
  feed(st, 'a', root, 1, 0)
  // make a second specimen
  let guard = 0
  while (Object.keys(st.specs).length < 3 && guard++ < 500) { const x = Object.keys(st.specs).map(Number)[0]; feed(st, 'a', x, 5, 0) }
  const ids = Object.keys(st.specs).map(Number)
  const lender = ids.find((i) => (st.specs[i].claims.a ?? 0) > 0)!
  const target = ids.find((i) => i !== lender)!
  useSink(st, 'a', 'steer', lender, target, 0)
  ok(st.specs[lender].steer === target, 'steer stored on the lender')
  throws(() => useSink(st, 'a', 'steer', lender, lender, 0), 'cannot steer to itself', 'steer to itself refused')
  const before = st.events.filter((e) => e.type === 'loan').length
  for (let i = 0; i < 300 && st.events.filter((e) => e.type === 'loan').length === before && st.specs[lender]; i++) feed(st, 'a', lender, 0.5, 0)
  const ln = st.events.filter((e) => e.type === 'loan').slice(before)[0]
  ok(ln !== undefined && ln.type === 'loan', 'a loan happened in the steer test')
  if (ln && ln.type === 'loan' && ln.lender === lender) ok(ln.borrower === target, 'steered loan goes to the chosen specimen')
  else ok(st.specs[lender] === undefined || st.specs[lender].steer === target, 'steer kept until the lender itself lends')
  check(st)
}

// ---------------------------------------------------------------- eENERGY accrues only while placed
{
  const st = create(13, 0)
  join(st, 'a', 0)
  join(st, 'b', 0)
  feed(st, 'a', 0, 1000, 0)
  tick(st, 10 * H)
  drawAll(st, 'a', 10 * H)
  const expect = (1000 * VALUES.eRatePerYear * 10) / (365 * 24)
  ok(close(st.players.a.eEnergy, expect), 'eENERGY = placed x rate x time')
  ok(st.players.b.eEnergy === 0, 'no eENERGY on dENERGY left unplaced')
}

// ---------------------------------------------------------------- determinism + 3-era bot run
function botRun(seed: number): State {
  const st = create(seed, 0)
  let t = 0
  const ids: string[] = []
  let r = seed * 7919
  const rnd = () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  const end = 160 * 24 * H
  while (t < end && st.era < 3) {
    t += 15 * 60_000
    tick(st, t)
    const day = t / (24 * H)
    const want = Math.min(400, Math.floor(3 * (1 + day * 4)))
    while (ids.length < want) { const id = `u${ids.length}`; join(st, id, t, ids.length ? ids[Math.floor(rnd() * ids.length)] : undefined); ids.push(id) }
    for (const id of ids) {
      if (rnd() > 0.06) continue
      const p = st.players[id]
      const s = status(st)
      const live = Object.values(st.specs)
      if (rnd() < 0.05 && Object.keys(p.placed).length) { drawAll(st, id, t); continue }
      // spend on the shortest mutation objective
      const short = Object.entries(s.short).sort((a, b) => b[1] - a[1])[0]
      if (short) {
        const m = Number(short[0])
        if (!p.activated.includes(m) && p.bloom >= activateCost(st)) activate(st, id, m, t)
        if (p.activated.includes(m)) {
          for (const sp of live.filter((x) => x.mass >= 100 && !x.shown.includes(m) && !x.expressed.includes(m)).slice(0, 5)) {
            if (p.bloom < expressCost(st, id, m)) break
            express(st, id, m, sp.id, t)
          }
        }
      }
      if (p.dEnergy < 1) continue
      const below = live.filter((x) => x.mass < 100).sort((a, b) => b.mass - a.mass)
      const empties = live.filter((x) => x.mass < s.kMin)
      const target = empties[0] ?? (s.qualifying < s.nReq && below[0]) ?? live[Math.floor(rnd() * live.length)]
      if (!st.specs[target.id]) continue
      feed(st, id, target.id, Math.min(p.dEnergy, 20 + rnd() * 80), t)
    }
    tick(st, t)
    check(st)
  }
  return st
}
{
  const a = botRun(21)
  const b = botRun(21)
  ok(JSON.stringify(a.history) === JSON.stringify(b.history) && a.rng === b.rng, 'same seed and actions give the same game')
  ok(a.history.length >= 20, `bot run covers many epochs (${a.history.length})`)
  ok(a.history.some((h) => h.bloomed) && a.history.some((h) => h.era >= 1), 'bot run Blooms and reaches era 2')
  ok(a.events.some((e) => e.type === 'express') && a.events.some((e) => e.type === 'show'), 'bot run uses mutations')
  const summary = a.history.map((h) => `${h.era + 1}.${h.epoch + 1}${h.bloomed ? '*' : '-'}`).join(' ')
  console.log('bot run:', summary)
  console.log(`  ${a.history.filter((h) => h.bloomed).length}/${a.history.length} Bloomed, ${Object.keys(a.players).length} players, BLOOM burned ${a.burned.toFixed(0)} of ${a.playerReleased.toFixed(0)}`)
}

// state is plain JSON (the server stores it)
{
  const st = botRun(4)
  const copy = JSON.parse(JSON.stringify(st)) as State
  ok(JSON.stringify(copy) === JSON.stringify(st), 'state survives JSON round trip')
  check(copy)
}

console.log(`${n} checks passed`)
