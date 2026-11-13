// Passkey sign-up / sign-in against `cf dev`, with a software authenticator (ES256, attestation "none").
// Run: node --experimental-strip-types --no-warnings test/passkey.ts
import { encodeCBOR } from '@levischuck/tiny-cbor'
import { createHash, generateKeyPairSync, sign, randomBytes } from 'node:crypto'

const BASE = process.env.BASE ?? 'http://localhost:8787'
const ORIGIN = 'http://localhost:5173'
const RP_ID = 'localhost'
let n = 0
function ok(c: unknown, what: string) { if (!c) { console.error(`FAIL ${what}`); process.exit(1) } n++; console.log(`ok ${what}`) }
const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url')
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest()

async function post(path: string, body: unknown = {}, token?: string) {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
  return { status: r.status, d: await r.json() as any }
}

class Authenticator {
  keys = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  credId = randomBytes(16)
  count = 0
  userHandle: Uint8Array | null = null
  private authData(withCred: boolean) {
    const flags = 0x01 | 0x04 | (withCred ? 0x40 : 0) // UP, UV, AT
    const counter = Buffer.alloc(4); counter.writeUInt32BE(++this.count)
    const parts = [sha(RP_ID), Buffer.from([flags]), counter]
    if (withCred) {
      const jwk = this.keys.publicKey.export({ format: 'jwk' }) as { x: string; y: string }
      const cose = encodeCBOR(new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]))
      const len = Buffer.alloc(2); len.writeUInt16BE(this.credId.length)
      parts.push(Buffer.alloc(16), len, this.credId, Buffer.from(cose))
    }
    return Buffer.concat(parts)
  }
  create(o: any, origin = ORIGIN) {
    this.userHandle = Buffer.from(o.user.id, 'base64url')
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: o.challenge, origin }))
    const att = encodeCBOR(new Map<string, string | Uint8Array | Map<string, number>>([['fmt', 'none'], ['attStmt', new Map<string, number>()], ['authData', this.authData(true)]]))
    return { id: b64u(this.credId), rawId: b64u(this.credId), type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientData), attestationObject: b64u(att), transports: ['internal'] } }
  }
  get(o: any, origin = ORIGIN) {
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: o.challenge, origin }))
    const ad = this.authData(false)
    const sig = sign('sha256', Buffer.concat([ad, sha(clientData)]), this.keys.privateKey)
    return { id: b64u(this.credId), rawId: b64u(this.credId), type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(ad), signature: b64u(sig), userHandle: b64u(this.userHandle!) } }
  }
}

// sign-up
const dev = new Authenticator()
let ro = (await post('/api/register/options')).d
const reg = dev.create(ro.options)
const rv = await post('/api/register/verify', { flow: ro.flow, response: reg })
ok(rv.status === 200 && rv.d.me.dEnergy === 1000 && rv.d.token, 'passkey sign-up: account with 1,000 dENERGY')
const id = rv.d.me.id
ok((await post('/api/register/verify', { flow: ro.flow, response: reg })).status === 400, 'sign-up challenge is single-use')

// same passkey cannot make a second account
ro = (await post('/api/register/options')).d
const r2 = await post('/api/register/verify', { flow: ro.flow, response: dev.create(ro.options) })
ok(r2.status === 400 && r2.d.error === 'passkey already used', 'one account per passkey')

// wrong origin refused (phishing site)
ro = (await post('/api/register/options')).d
ok((await post('/api/register/verify', { flow: ro.flow, response: new Authenticator().create(ro.options, 'https://evil.example') })).status === 400, 'passkey from another site refused')

// sign-in
let lo = (await post('/api/login/options')).d
const lv = await post('/api/login/verify', { flow: lo.flow, response: dev.get(lo.options) })
ok(lv.status === 200 && lv.d.me.id === id, 'passkey sign-in returns the same account')

// a forged signature is refused
lo = (await post('/api/login/options')).d
const forged = dev.get(lo.options)
forged.response.signature = b64u(randomBytes(70))
ok((await post('/api/login/verify', { flow: lo.flow, response: forged })).status === 400, 'forged signature refused')

// a different device's key under the same credential id is refused
lo = (await post('/api/login/options')).d
const thief = new Authenticator(); thief.credId = dev.credId; thief.userHandle = dev.userHandle
ok((await post('/api/login/verify', { flow: lo.flow, response: thief.get(lo.options) })).status === 400, 'wrong key for a passkey refused')

// invites: single use, then referral pays on first feed
const token = lv.d.token
const code = (await post('/api/invite', {}, token)).d.code
ok(typeof code === 'string', 'invite link code made')
const friend = new Authenticator()
ro = (await post('/api/register/options')).d
const fr = await post('/api/register/verify', { flow: ro.flow, response: friend.create(ro.options), invite: code })
ok(fr.status === 200, 'friend joins with invite')
const third = new Authenticator()
ro = (await post('/api/register/options')).d
await post('/api/register/verify', { flow: ro.flow, response: third.create(ro.options), invite: code })
const col = await (await fetch(BASE + '/api/colony')).json() as any
await post('/api/action', { type: 'feed', spec: col.specs[0].id, amount: 10 }, fr.d.token)
const me = (await post('/api/me', {}, token)).d.me
ok(me.dEnergy === 1500, 'inviter +500 once, invite single-use')

// sign out ends the session
await post('/api/logout', {}, token)
ok((await post('/api/me', {}, token)).status === 401, 'signed-out token refused')

console.log(`${n} passkey checks passed`)
