# server

Demo game server: one shared colony on a Cloudflare Durable Object, running the rules in `../engine`. No chain, no wallet. Browsers send actions; the server applies the rules and sends events to everyone.

## Run locally

```sh
npm install
npm run dev        # http://localhost:8787
npm test           # with dev running: server checks + passkey checks
```

`.dev.vars` (gitignored) holds `ADMIN_KEY` for the demo controls.

## API

| Route | What |
|---|---|
| `GET /api/colony` | Public colony view (specimens, loans, objectives, recent epochs). No balances. |
| `GET /api/live` | WebSocket: a snapshot on connect, then batches of game events. |
| `POST /api/register/options`, `/api/register/verify` | Passkey sign-up (optional `invite` code). Returns a session token. |
| `POST /api/login/options`, `/api/login/verify` | Passkey sign-in. |
| `POST /api/me` | Your balances, costs and invites. |
| `POST /api/invite` | New single-use invite code. |
| `POST /api/action` | `feed`, `draw`, `drawAll`, `activate`, `express`, `burn`, `activateSink`, `useSink`. |
| `POST /api/logout` | Ends the session. |
| `POST /api/admin/speed` `{speed}` | Demo control: game time x speed (1-10,000). Needs `x-admin-key`. |
| `POST /api/admin/reset` | Demo control: new colony, every account back to 1,000. |
| `POST /api/admin/bot`, `/api/admin/state` | Test players and full state, for tests and activity bots. |

## Rules that protect players

- Only the server changes balances; every change goes through the engine, which checks conservation rules.
- Sign-in is a passkey bound to this site: one account per passkey, challenges are single-use and expire in 5 minutes, a passkey from another site or a forged signature is refused.
- Sessions are random 32-byte tokens; only their SHA-256 hash is stored; they end after 30 days or on sign-out.
- Invite codes are single-use and cannot be used by their owner.
