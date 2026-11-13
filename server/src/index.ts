// Demo game server. Every /api request goes to the one shared colony.
import { env } from 'cloudflare:workers'
import { Colony } from './colony.ts'

export { Colony }

const COLONY = 'demo-1'

export default {
  async fetch(req, _env, ctx) {
    const url = new URL(req.url)
    if (!url.pathname.startsWith('/api/')) return new Response('not found', { status: 404 })
    const cors = corsHeaders(req)
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
    const stub = ctx.exports.Colony.getByName(COLONY)
    const res = await stub.fetch(req)
    if (res.status === 101) return res
    const out = new Response(res.body, res)
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v)
    return out
  },
} satisfies ExportedHandler<Env>

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin')
  if (!origin || !env.ORIGIN.split(',').map((s) => s.trim()).includes(origin)) return {}
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    vary: 'origin',
  }
}
