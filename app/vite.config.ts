import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev server. LAN=1 opens it to phones on the same Wi-Fi (see README, "Testing on devices").
// The browser reaches the local chain through /rpc on this same server, so a phone never
// needs to see port 8545 directly; the chain itself stays bound to this Mac.
const lan = process.env.LAN === '1'

export default defineConfig({
  plugins: [react()],
  server: {
    host: lan ? '0.0.0.0' : '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/rpc': { target: 'http://127.0.0.1:8545', rewrite: () => '/' } },
  },
})
