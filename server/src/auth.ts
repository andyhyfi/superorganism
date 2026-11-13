// Passkey sign-in (WebAuthn) and sessions. No email, no password.
// One account per passkey. Sessions are random bearer tokens; only their SHA-256 hash is stored.
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server'

export const SESSION_DAYS = 30
const CHALLENGE_MS = 5 * 60_000

export interface Rp { id: string; origin: string[]; name: string }

export function randomId(bytes = 16): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes))
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('')
}

const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const fromB64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0))

export class Auth {
  private sql: SqlStorage
  constructor(sql: SqlStorage) {
    this.sql = sql
    sql.exec(`CREATE TABLE IF NOT EXISTS accounts (player TEXT PRIMARY KEY, created INTEGER NOT NULL)`)
    sql.exec(`CREATE TABLE IF NOT EXISTS credentials (
      id TEXT PRIMARY KEY, player TEXT NOT NULL, public_key TEXT NOT NULL, counter INTEGER NOT NULL, transports TEXT)`)
    sql.exec(`CREATE TABLE IF NOT EXISTS challenges (flow TEXT PRIMARY KEY, challenge TEXT NOT NULL, kind TEXT NOT NULL, player TEXT, expires INTEGER NOT NULL)`)
    sql.exec(`CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, player TEXT NOT NULL, expires INTEGER NOT NULL)`)
    sql.exec(`CREATE TABLE IF NOT EXISTS invites (code TEXT PRIMARY KEY, owner TEXT NOT NULL, used_by TEXT, created INTEGER NOT NULL)`)
  }

  private takeChallenge(flow: string, kind: string): { challenge: string; player: string | null } {
    const now = Date.now()
    this.sql.exec(`DELETE FROM challenges WHERE expires < ?`, now)
    const row = this.sql.exec<{ challenge: string; player: string | null; kind: string }>(
      `SELECT challenge, player, kind FROM challenges WHERE flow = ?`, flow).toArray()[0]
    this.sql.exec(`DELETE FROM challenges WHERE flow = ?`, flow) // single use
    if (!row || row.kind !== kind) throw new AuthError('sign-in expired, try again')
    return row
  }

  async registerOptions(rp: Rp) {
    const player = randomId(12)
    const opts = await generateRegistrationOptions({
      rpName: rp.name, rpID: rp.id, userName: `player-${player.slice(0, 6)}`, userID: Uint8Array.from(new TextEncoder().encode(player)),
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    })
    const flow = randomId()
    this.sql.exec(`INSERT INTO challenges (flow, challenge, kind, player, expires) VALUES (?, ?, 'reg', ?, ?)`,
      flow, opts.challenge, player, Date.now() + CHALLENGE_MS)
    return { flow, options: opts }
  }

  /** Returns the new player id. */
  async registerVerify(rp: Rp, flow: string, response: RegistrationResponseJSON): Promise<string> {
    const { challenge, player } = this.takeChallenge(flow, 'reg')
    const v = await verifyRegistrationResponse({
      response, expectedChallenge: challenge, expectedOrigin: rp.origin, expectedRPID: rp.id, requireUserVerification: false,
    }).catch(() => { throw new AuthError('passkey not verified') })
    if (!v.verified || !v.registrationInfo || !player) throw new AuthError('passkey not verified')
    const c = v.registrationInfo.credential
    if (this.sql.exec(`SELECT 1 FROM credentials WHERE id = ?`, c.id).toArray().length) throw new AuthError('passkey already used')
    this.sql.exec(`INSERT INTO accounts (player, created) VALUES (?, ?)`, player, Date.now())
    this.sql.exec(`INSERT INTO credentials (id, player, public_key, counter, transports) VALUES (?, ?, ?, ?, ?)`,
      c.id, player, b64u(c.publicKey), c.counter, JSON.stringify(c.transports ?? []))
    return player
  }

  async loginOptions(rp: Rp) {
    const opts = await generateAuthenticationOptions({ rpID: rp.id, userVerification: 'preferred' })
    const flow = randomId()
    this.sql.exec(`INSERT INTO challenges (flow, challenge, kind, player, expires) VALUES (?, ?, 'auth', NULL, ?)`,
      flow, opts.challenge, Date.now() + CHALLENGE_MS)
    return { flow, options: opts }
  }

  async loginVerify(rp: Rp, flow: string, response: AuthenticationResponseJSON): Promise<string> {
    const { challenge } = this.takeChallenge(flow, 'auth')
    if (typeof response?.id !== 'string') throw new AuthError('bad passkey response')
    const row = this.sql.exec<{ player: string; public_key: string; counter: number; transports: string }>(
      `SELECT player, public_key, counter, transports FROM credentials WHERE id = ?`, response.id).toArray()[0]
    if (!row) throw new AuthError('unknown passkey')
    const v = await verifyAuthenticationResponse({
      response, expectedChallenge: challenge, expectedOrigin: rp.origin, expectedRPID: rp.id, requireUserVerification: false,
      credential: { id: response.id, publicKey: fromB64u(row.public_key), counter: row.counter, transports: JSON.parse(row.transports) },
    }).catch(() => { throw new AuthError('passkey not verified') })
    if (!v.verified) throw new AuthError('passkey not verified')
    this.sql.exec(`UPDATE credentials SET counter = ? WHERE id = ?`, v.authenticationInfo.newCounter, response.id)
    return row.player
  }

  async newSession(player: string): Promise<string> {
    const token = randomId(32)
    this.sql.exec(`INSERT INTO sessions (hash, player, expires) VALUES (?, ?, ?)`,
      await sha256(token), player, Date.now() + SESSION_DAYS * 86_400_000)
    return token
  }

  async player(token: string | null): Promise<string | null> {
    if (!token) return null
    const row = this.sql.exec<{ player: string; expires: number }>(
      `SELECT player, expires FROM sessions WHERE hash = ?`, await sha256(token)).toArray()[0]
    if (!row || row.expires < Date.now()) return null
    return row.player
  }

  async endSession(token: string) {
    this.sql.exec(`DELETE FROM sessions WHERE hash = ?`, await sha256(token))
  }

  players(): string[] {
    return this.sql.exec<{ player: string }>(`SELECT player FROM accounts`).toArray().map((r) => r.player)
  }

  // ---------------------------------------------------------------- invites (single use)
  newInvite(owner: string): string {
    const code = randomId(9)
    this.sql.exec(`INSERT INTO invites (code, owner, used_by, created) VALUES (?, ?, NULL, ?)`, code, owner, Date.now())
    return code
  }

  /** Returns the inviter if the code is valid and unused; marks it used by `player`. */
  useInvite(code: string | undefined, player: string): string | null {
    if (!code) return null
    const row = this.sql.exec<{ owner: string; used_by: string | null }>(
      `SELECT owner, used_by FROM invites WHERE code = ?`, code).toArray()[0]
    if (!row || row.used_by || row.owner === player) return null
    this.sql.exec(`UPDATE invites SET used_by = ? WHERE code = ?`, player, code)
    return row.owner
  }

  invites(owner: string) {
    return this.sql.exec<{ code: string; used_by: string | null }>(
      `SELECT code, used_by FROM invites WHERE owner = ? ORDER BY created`, owner).toArray()
  }
}

export class AuthError extends Error {}
