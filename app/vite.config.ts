import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'

// Dev server. LAN=1 opens it to phones on the same Wi-Fi (see README, "Testing on devices").
// The browser reaches the local chain through /rpc on this same server, so a phone never
// needs to see port 8545 directly; the chain itself stays bound to this Mac.
// DEMO=1 runs the play-money demo instead: /api goes to the game server (server/, port 8787).
const lan = process.env.LAN === '1'
const demo = process.env.DEMO === '1'

/** Demo controls key, from the game server's gitignored .dev.vars. Dev server only; never in a build. */
function adminKey(command: string): string {
  if (!demo || command !== 'serve') return ''
  try { return fs.readFileSync(new URL('../server/.dev.vars', import.meta.url), 'utf8').match(/ADMIN_KEY=(.+)/)?.[1].trim() ?? '' } catch { return '' }
}

export default defineConfig(({ command }) => ({
  plugins: [react()],
  define: { __DEMO__: JSON.stringify(demo), __DEMO_ADMIN__: JSON.stringify(adminKey(command)) },
  server: {
    // passkeys need the name "localhost" (not 127.0.0.1) on this Mac
    host: lan ? '0.0.0.0' : demo ? 'localhost' : '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/rpc': { target: 'http://127.0.0.1:8545', rewrite: () => '/' },
      '/api': { target: 'http://localhost:8787', ws: true },
    },
  },
}))
