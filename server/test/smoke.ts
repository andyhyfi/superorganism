// Server smoke test against `cf dev` (port 8787). Uses admin test players (no passkeys) and fast time.
// Run: node --experimental-strip-types --no-warnings test/smoke.ts
import fs from 'node:fs'

const BASE = process.env.BASE ?? 'http://localhost:8787'
const KEY = fs.readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8').match(/ADMIN_KEY=(.+)/)![1].trim()
let n = 0
function ok(c: unknown, what: string) { if (!c) { console.error(`FAIL ${what}`); process.exit(1) } n++; console.log(`ok ${what}`) }

async function call(path: string, body?: unknown, token?: string, admin = false) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  if (admin) headers['x-admin-key'] = KEY
  const r = await fetch(BASE + path, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: r.status, data: await r.json() as any }
}

// admin is protected
ok((await call('/api/admin/reset', {})).status === 403, 'admin needs the key')
ok((await call('/api/admin/reset', {}, undefined, true)).data.ok, 'reset')
ok((await call('/api/admin/speed', { speed: 1 }, undefined, true)).data.speed === 1, 'speed 1')

// actions need a session
ok((await call('/api/action', { type: 'feed', spec: 0, amount: 5 })).status === 401, 'actions need sign-in')
ok((await call('/api/action', { type: 'feed', spec: 0, amount: 5 }, 'forged-token')).status === 401, 'forged token refused')

// players and referral
const a = (await call('/api/admin/bot', { id: 'a' }, undefined, true)).data
const b = (await call('/api/admin/bot', { id: 'b', inviter: a.id }, undefined, true)).data
let me = (await call('/api/me', {}, a.token)).data.me
ok(me.dEnergy === 1000, 'sign-up gives 1,000 dENERGY')

// live socket receives events
const ws = new WebSocket(BASE.replace('http', 'ws') + '/api/live')
const got: any[] = []
await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('ws')) })
ws.onmessage = (e) => got.push(JSON.parse(String(e.data)))
await new Promise((r) => setTimeout(r, 300))
ok(got.some((m) => m.type === 'snapshot' && Array.isArray(m.specs)), 'live: snapshot on connect')

const colony = (await call('/api/colony')).data
const root = colony.specs[0].id
let r = await call('/api/action', { type: 'feed', spec: root, amount: 40 }, b.token)
ok(r.status === 200 && r.data.me.dEnergy === 960, 'feed moves dENERGY onto the colony')
me = (await call('/api/me', {}, a.token)).data.me
ok(me.dEnergy === 1500, 'inviter gets 500 when the invited player feeds')
await new Promise((r) => setTimeout(r, 300))
ok(got.some((m) => m.type === 'events' && m.events.some((e: any) => e.type === 'feed')), 'live: feed event broadcast')

// rule errors come back as 400 with the reason
r = await call('/api/action', { type: 'feed', spec: root, amount: 99999 }, a.token)
ok(r.status === 400 && r.data.error === 'not enough dENERGY', 'over-spend refused')
r = await call('/api/action', { type: 'draw', spec: root, amount: 10 }, a.token)
ok(r.status === 400 && r.data.error === 'nothing placed there', 'cannot draw from others')
r = await call('/api/action', { type: 'bogus' }, a.token)
ok(r.status === 400, 'unknown action refused')
r = await call('/api/action', { type: 'feed', spec: 'x', amount: 1 }, a.token)
ok(r.status === 400, 'bad input refused')

// draw all returns everything
r = await call('/api/action', { type: 'drawAll' }, b.token)
ok(r.data.me.dEnergy === 1000 && r.data.me.stake === 0, 'draw all returns every dENERGY')

// fast time: an empty epoch fails at 2x its 24 h target and the next starts
await call('/api/admin/speed', { speed: 3600 }, undefined, true) // 1 game hour per real second
await new Promise((r) => setTimeout(r, 50_000))
const st = (await call('/api/admin/state', {}, undefined, true)).data
ok(st.history.length >= 1 && st.history[0].bloomed === false, `fast time: epoch 1 ended (${st.history.length} epochs)`)
ok(got.some((m) => m.type === 'events' && m.events.some((e: any) => e.type === 'epoch')), 'live: new epoch broadcast')
await call('/api/admin/speed', { speed: 1 }, undefined, true)

// persistence: state survives (read twice, same epoch count)
const st2 = (await call('/api/admin/state', {}, undefined, true)).data
ok(st2.history.length >= st.history.length, 'state persists between requests')

ws.close()
console.log(`${n} server checks passed`)
