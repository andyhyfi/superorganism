// The demo colony: one Durable Object holds the shared game. The engine is the only rule-maker;
// browsers send actions and receive events. Game time = real time x speed (fast mode for testing).
import { DurableObject } from 'cloudflare:workers'
import {
  activate, activateSink, burn, create, draw, drawAll, express, feed, join, status, tick, useSink, RuleError,
  activateCost, expressCost, sinkCost, sinkOpen, SINKS, type GameEvent, type Sink, type State,
} from '../../engine/src/engine.ts'
import { Auth, AuthError, type Rp } from './auth.ts'

export interface ColonyEnv {
  RP_ID: string
  ORIGIN: string
  ADMIN_KEY?: string
}

interface Clock { gameT0: number; realT0: number; speed: number }

const MAX_EVENTS_PER_MESSAGE = 500

export class Colony extends DurableObject<ColonyEnv> {
  private auth: Auth
  private st!: State
  private clock!: Clock

  constructor(ctx: DurableObjectState, env: ColonyEnv) {
    super(ctx, env)
    const sql = ctx.storage.sql
    sql.exec(`CREATE TABLE IF NOT EXISTS game (k TEXT PRIMARY KEY, v TEXT NOT NULL)`)
    this.auth = new Auth(sql)
    const row = (k: string) => sql.exec<{ v: string }>(`SELECT v FROM game WHERE k = ?`, k).toArray()[0]?.v
    const c = row('clock')
    const s = row('state')
    this.clock = c ? JSON.parse(c) : { gameT0: Date.now(), realT0: Date.now(), speed: 1 }
    this.st = s ? JSON.parse(s) : create(Date.now() & 0x7fffffff, this.clock.gameT0)
    if (!s) this.save()
  }

  // ---------------------------------------------------------------- time and storage
  private now(): number {
    return this.clock.gameT0 + (Date.now() - this.clock.realT0) * this.clock.speed
  }

  private save() {
    const sql = this.ctx.storage.sql
    sql.exec(`INSERT OR REPLACE INTO game (k, v) VALUES ('state', ?)`, JSON.stringify(this.st))
    sql.exec(`INSERT OR REPLACE INTO game (k, v) VALUES ('clock', ?)`, JSON.stringify(this.clock))
  }

  /** Persist, then send new events to every browser, then schedule the next timed rule. */
  private async commit() {
    const events = this.st.events
    this.st.events = []
    this.save()
    if (events.length) this.broadcast(events)
    await this.schedule()
  }

  private async schedule() {
    const st = this.st
    const v = st.v
    const deadline = st.epochStart + v.targetHours[st.epoch] * v.failFactor * 3_600_000
    let next = Math.min(st.nextCheck, deadline)
    for (const l of st.loans) next = Math.min(next, l.end)
    const realWait = Math.max(500, (next - this.now()) / this.clock.speed)
    await this.ctx.storage.setAlarm(Date.now() + realWait)
  }

  async alarm() {
    tick(this.st, this.now())
    await this.commit()
  }

  // ---------------------------------------------------------------- live updates
  private broadcast(events: GameEvent[]) {
    const msg = JSON.stringify({ type: 'events', events: events.slice(-MAX_EVENTS_PER_MESSAGE), summary: this.summary() })
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(msg) } catch { /* closed */ }
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (message === 'snapshot') ws.send(JSON.stringify({ type: 'snapshot', ...this.view() }))
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    try { ws.close(code, reason) } catch { /* already closed */ }
  }

  // ---------------------------------------------------------------- views
  private summary() {
    const st = this.st
    const s = status(st)
    return {
      t: st.t, speed: this.clock.speed, era: st.era, epoch: st.epoch, level: st.level, players: Object.keys(st.players).length,
      objective: { nReq: s.nReq, qualifying: s.qualifying, holdH: s.holdH, traits: s.traits, short: s.short, kMin: s.kMin, empties: s.empties, ok: s.ok },
      holdSince: st.holdSince, epochStart: st.epochStart, deadline: st.epochStart + st.v.targetHours[st.epoch] * st.v.failFactor * 3_600_000,
      sinks: Object.fromEntries(SINKS.map((k) => [k, sinkOpen(st, k)])), burnOpen: st.burnOpen,
    }
  }

  /** Public colony view: no balances, no player ids on claims. */
  private view() {
    const st = this.st
    const specs = Object.values(st.specs).map((s) => ({
      id: s.id, mass: s.mass, depth: s.depth, name: s.name, color: s.color, shown: s.shown, expressed: s.expressed,
      feeders: Object.keys(s.claims).length,
    }))
    return { summary: this.summary(), specs, loans: st.loans, history: st.history.slice(-30) }
  }

  private me(player: string) {
    const p = this.st.players[player]
    if (!p) return null
    const st = this.st
    return {
      id: p.id, dEnergy: p.dEnergy, placed: p.placed, stake: p.stake, eEnergy: p.eEnergy, bloom: p.bloom,
      activated: p.activated, sinks: p.sinks,
      costs: {
        activate: activateCost(st),
        express: Object.fromEntries(Object.keys(status(st).traits).map((m) => [m, expressCost(st, player, Number(m))])),
        sinks: Object.fromEntries(SINKS.map((k) => [k, sinkCost(st, player, k)])),
      },
      invites: this.auth.invites(player),
    }
  }

  // ---------------------------------------------------------------- requests
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname
    try {
      if (path === '/api/live') {
        if (req.headers.get('Upgrade') !== 'websocket') return json({ error: 'websocket expected' }, 426)
        const [client, server] = Object.values(new WebSocketPair())
        this.ctx.acceptWebSocket(server)
        tick(this.st, this.now())
        await this.commit()
        server.send(JSON.stringify({ type: 'snapshot', ...this.view() }))
        return new Response(null, { status: 101, webSocket: client })
      }
      if (req.method === 'GET' && path === '/api/colony') {
        tick(this.st, this.now())
        await this.commit()
        return json(this.view())
      }
      if (req.method !== 'POST' && path !== '/api/me') return json({ error: 'not found' }, 404)
      const body = req.method === 'POST' ? await readJson(req) : {}
      const rp = this.rp()

      // sign-in
      if (path === '/api/register/options') return json(await this.auth.registerOptions(rp))
      if (path === '/api/register/verify') {
        const player = await this.auth.registerVerify(rp, str(body.flow), body.response as never)
        const inviter = this.auth.useInvite(typeof body.invite === 'string' ? body.invite : undefined, player)
        join(this.st, player, this.now(), inviter ?? undefined)
        await this.commit()
        return json({ token: await this.auth.newSession(player), me: this.me(player) })
      }
      if (path === '/api/login/options') return json(await this.auth.loginOptions(rp))
      if (path === '/api/login/verify') {
        const player = await this.auth.loginVerify(rp, str(body.flow), body.response as never)
        if (!this.st.players[player]) join(this.st, player, this.now())
        await this.commit()
        return json({ token: await this.auth.newSession(player), me: this.me(player) })
      }

      // admin (demo controls): fast time and reset
      if (path.startsWith('/api/admin/')) return await this.admin(req, path, body)

      // signed-in actions
      const token = bearer(req)
      const player = await this.auth.player(token)
      if (!player) return json({ error: 'sign in first' }, 401)
      if (path === '/api/me') { tick(this.st, this.now()); await this.commit(); return json({ me: this.me(player) }) }
      if (path === '/api/logout') { await this.auth.endSession(token!); return json({ ok: true }) }
      if (path === '/api/invite') return json({ code: this.auth.newInvite(player) })
      if (path === '/api/action') {
        this.act(player, body)
        await this.commit()
        return json({ me: this.me(player) })
      }
      return json({ error: 'not found' }, 404)
    } catch (e) {
      if (e instanceof RuleError || e instanceof AuthError || e instanceof BadRequest) return json({ error: e.message }, 400)
      console.error(e)
      return json({ error: 'server error' }, 500)
    }
  }

  private act(player: string, b: Record<string, unknown>) {
    const st = this.st
    const t = this.now()
    switch (b.type) {
      case 'feed': return feed(st, player, int(b.spec), num(b.amount), t)
      case 'draw': return draw(st, player, int(b.spec), num(b.amount), t)
      case 'drawAll': return drawAll(st, player, t)
      case 'activate': return activate(st, player, int(b.mutation), t)
      case 'express': return express(st, player, int(b.mutation), int(b.spec), t)
      case 'burn': return burn(st, player, num(b.amount), t)
      case 'activateSink': return activateSink(st, player, sink(b.sink), t)
      case 'useSink': {
        const value = typeof b.value === 'string' ? b.value.slice(0, 32) : num(b.value)
        return useSink(st, player, sink(b.sink), int(b.spec), value, t)
      }
      default: throw new BadRequest('unknown action')
    }
  }

  private async admin(req: Request, path: string, body: Record<string, unknown>) {
    const key = this.env.ADMIN_KEY
    if (!key || req.headers.get('x-admin-key') !== key) return json({ error: 'not allowed' }, 403)
    if (path === '/api/admin/speed') {
      const speed = num(body.speed)
      if (speed < 1 || speed > 10_000) throw new BadRequest('speed 1-10000')
      const g = this.now()
      this.clock = { gameT0: g, realT0: Date.now(), speed }
      tick(this.st, g)
      await this.commit()
      return json({ speed })
    }
    if (path === '/api/admin/bot') {
      // test players for activity bots and tests (no passkey). Same rules as everyone else.
      const id = `bot-${str(body.id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24)}`
      if (!this.st.players[id]) join(this.st, id, this.now(), typeof body.inviter === 'string' ? body.inviter : undefined)
      await this.commit()
      return json({ id, token: await this.auth.newSession(id) })
    }
    if (path === '/api/admin/state') {
      tick(this.st, this.now())
      await this.commit()
      return json({ clock: this.clock, history: this.st.history, players: this.st.players, released: this.st.released,
        playerReleased: this.st.playerReleased, treasury: this.st.treasury, burned: this.st.burned })
    }
    if (path === '/api/admin/reset') {
      const g = Date.now()
      this.clock = { gameT0: g, realT0: g, speed: this.clock.speed }
      this.st = create(g & 0x7fffffff, g)
      for (const p of this.auth.players()) join(this.st, p, g)
      await this.commit()
      for (const ws of this.ctx.getWebSockets()) ws.send(JSON.stringify({ type: 'snapshot', ...this.view() }))
      return json({ ok: true, players: Object.keys(this.st.players).length })
    }
    return json({ error: 'not found' }, 404)
  }

  private rp(): Rp {
    return { id: this.env.RP_ID, origin: this.env.ORIGIN.split(',').map((s) => s.trim()), name: 'Evolution' }
  }
}

// ---------------------------------------------------------------- helpers
class BadRequest extends Error {}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text()
  if (text.length > 20_000) throw new BadRequest('too large')
  try {
    const v = JSON.parse(text || '{}')
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error()
    return v
  } catch { throw new BadRequest('bad json') }
}

function bearer(req: Request): string | null {
  const h = req.headers.get('authorization')
  return h?.startsWith('Bearer ') ? h.slice(7) : null
}

const str = (v: unknown) => { if (typeof v !== 'string' || !v) throw new BadRequest('bad request'); return v }
const num = (v: unknown) => { const n = Number(v); if (!Number.isFinite(n)) throw new BadRequest('bad number'); return n }
const int = (v: unknown) => { const n = num(v); if (!Number.isInteger(n)) throw new BadRequest('bad id'); return n }
const sink = (v: unknown): Sink => { if (!SINKS.includes(v as Sink)) throw new BadRequest('unknown sink'); return v as Sink }
