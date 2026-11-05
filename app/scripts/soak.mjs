// Long-run soak: drives the real app in headless Chrome for N minutes at phone size,
// samples memory/cells/errors every 30 s, and compares the field to the chain at the end.
// Dev tool only. Usage: node scripts/soak.mjs [minutes]
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const MIN = Number(process.argv[2] || 10)
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 9333
const proc = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--user-data-dir=' + process.env.TMPDIR + '/soak-profile',
  '--window-size=393,852', '--enable-precise-memory-info', 'about:blank',
], { stdio: 'ignore' })

let ws, id = 0
const pending = new Map()
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const evalJs = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value

try {
  let target
  for (let k = 0; k < 50 && !target; k++) {
    await sleep(200)
    try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find(t => t.type === 'page') } catch {}
  }
  ws = new WebSocket(target.webSocketDebuggerUrl)
  ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id) } }
  await new Promise(r => (ws.onopen = r))
  await send('Emulation.setDeviceMetricsOverride', { width: 393, height: 852, deviceScaleFactor: 3, mobile: true })
  await send('Page.navigate', { url: 'http://127.0.0.1:5173/' })
  await sleep(6000)
  await evalJs(`window.__errs=[]; addEventListener('error', e => __errs.push(e.message)); addEventListener('unhandledrejection', e => __errs.push('rej '+(e.reason&&e.reason.message||e.reason))); 1`)
  const rows = []
  for (let t = 0; t <= MIN * 60; t += 30) {
    const s = await evalJs(`JSON.stringify({heap: Math.round(performance.memory.usedJSHeapSize/1e6), live: window.__field ? __field.liveCount() : -1, dom: document.getElementsByTagName('*').length, errs: __errs.length})`)
    const row = { t, ...JSON.parse(s) }
    rows.push(row)
    console.log(JSON.stringify(row))
    if (t < MIN * 60) await sleep(30000)
  }
  const errs = await evalJs('JSON.stringify(__errs)')
  console.log('errors', errs)
  const heaps = rows.map(r => r.heap)
  console.log('heap first/max/last MB', heaps[0], Math.max(...heaps), heaps.at(-1))
} finally {
  ws?.close()
  proc.kill()
}
