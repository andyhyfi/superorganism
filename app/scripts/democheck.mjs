// Demo check in headless Chrome: passkey sign-up (virtual authenticator), feed, live colony,
// activity bots, fast time to a new epoch. Needs `npm run demo` (5173) and the game server (8787).
// Usage: node scripts/democheck.mjs [phone]
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import fs from 'node:fs'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 9341
const phone = process.argv[2] === 'phone'
const W = phone ? 390 : 1728, H = phone ? 844 : 1117
const KEY = fs.readFileSync(new URL('../../server/.dev.vars', import.meta.url), 'utf8').match(/ADMIN_KEY=(.+)/)[1].trim()
const admin = (p, b) => fetch(`http://localhost:8787/api/admin/${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-key': KEY }, body: JSON.stringify(b) }).then(r => r.json())
const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--user-data-dir=' + process.env.TMPDIR + '/demo-profile-' + Date.now(), `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' })
let ws, id = 0
const pending = new Map()
const errors = []
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error(`timeout: ${method} ${String(params.expression ?? '').slice(0, 80)}`)) } }, 20000) })
const evalJs = async expr => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result?.result?.value }
const shot = async name => { const r = await send('Page.captureScreenshot', { format: 'png' }); const f = `${process.env.TMPDIR}/demo-${name}.png`; fs.writeFileSync(f, Buffer.from(r.result.data, 'base64')); return f }
let n = 0
const ok = (c, what) => { if (!c) { console.log(`FAIL ${what}`); process.exitCode = 1 } else { n++; console.log(`ok ${what}`) } }
const ds = () => evalJs(`({...document.querySelector('.stage')?.dataset})`)
const click = sel => evalJs(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})]; if (!b.length) return false; b[0].click(); return true })()`)
const clickText = (sel, text) => evalJs(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find(x => x.textContent.includes(${JSON.stringify(text)})); if (!b) return false; b.click(); return true })()`)
try {
  await admin('speed', { speed: 1 }); await admin('bots', { count: 0 }); await admin('reset', {})
  let target
  for (let k = 0; k < 50 && !target; k++) { await sleep(200); try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find(t => t.type === 'page') } catch {} }
  ws = new WebSocket(target.webSocketDebuggerUrl)
  ws.onmessage = m => {
    const d = JSON.parse(m.data)
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id) }
    if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails?.exception?.description?.slice(0, 200))
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push(d.params.args.map(a => a.value ?? a.description).join(' ').slice(0, 200))
  }
  await new Promise(r => (ws.onopen = r))
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: phone ? 3 : 2, mobile: phone })
  if (phone) await send('Emulation.setTouchEmulationEnabled', { enabled: true })
  await send('WebAuthn.enable')
  await send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })
  await send('Page.navigate', { url: 'http://localhost:5173/' })
  await sleep(5000)
  console.log('loaded', await evalJs('document.title'))
  let d = await ds()
  ok(d.signed === 'out', 'signed out at first visit')
  ok(await evalJs(`!!document.querySelector('.signin')`), 'sign-in card shown')
  await clickText('.signin .btn', 'Join')
  await sleep(2500)
  d = await ds()
  ok(d.signed === 'in', 'passkey sign-up works in the browser')
  ok(await evalJs(`document.querySelector('.money')?.textContent.includes('1,000.00')`), 'money bar shows 1,000 ENERGY')
  // close the guide if it is open
  await evalJs(`document.querySelector('.guide-skip')?.click()`)
  // pick the root specimen: open Study, Colony tab, first row
  await click('.controls .primary')
  await sleep(600)
  await evalJs(`[...document.querySelectorAll('.segmented[role=tablist] button')].find(b => b.textContent === 'Colony')?.click()`)
  await sleep(500)
  ok(await evalJs(`document.querySelector('.deep')?.textContent.includes('Objectives')`), 'colony tab shows the objectives (placeholder)')
  await click('.deep .group .cell .name')
  await evalJs(`[...document.querySelectorAll('.deep button.cell')].find(b => b.querySelector('.name'))?.click()`)
  await sleep(800)
  d = await ds()
  ok(d.tab === 'node' && d.selected !== '', `specimen menu open (selected ${d.selected})`)
  await evalJs(`(() => { const i = document.querySelector('.amount input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, '150'); i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await sleep(200)
  // triple-tap: only one feed may go through
  await evalJs(`(() => { const b = document.querySelector('.buttons .btn'); b.click(); b.click(); b.click() })()`)
  await sleep(1500)
  ok(await evalJs(`document.querySelector('.money')?.textContent.includes('850.00')`), 'feed 150: money bar 850 ENERGY, one feed only')
  const st = await admin('state', {})
  const feeders = Object.values(st.players).filter(p => !p.id.startsWith('bot-') && p.stake > 0)
  ok(feeders.length === 1 && Math.abs(feeders[0].stake - 150) < 1e-6, `server: exactly one feed of 150 (${feeders.map(p => p.stake).join(',')})`)
  await shot(phone ? 'phone-fed' : 'mac-fed')
  // bots and fast time
  await admin('bots', { count: 40 })
  await admin('speed', { speed: 600 })
  let blank = 0
  for (let k = 0; k < 30; k++) {
    await sleep(500)
    const x = await evalJs(`(() => { const d = document.querySelector('.stage').dataset; return d.selected !== '' && d.tab === 'node' && !document.querySelector('.deep .big') })()`)
    if (x) blank++
  }
  ok(blank === 0, `menu never blank while its specimen divides (${blank} blank samples of 30)`)
  const live = await evalJs(`__field ? [...__field.nodes.values()].length : 0`)
  ok(live > 1, `colony grows with bots: ${live} specimens on screen`)
  const selAfter = await ds()
  ok(selAfter.selected !== '' && await evalJs(`!!document.querySelector('.deep .big')`), `menu still on a specimen after divisions (selected ${selAfter.selected})`)
  await shot(phone ? 'phone-bots' : 'mac-bots')
  const ep0 = (await ds()).epoch
  await admin('speed', { speed: 10000 })
  let ep1 = ep0
  for (let k = 0; k < 40 && ep1 === ep0; k++) { await sleep(1000); ep1 = (await ds()).epoch }
  ok(ep1 !== ep0, `new epoch reached the browser (${ep0} -> ${ep1})`)
  await admin('speed', { speed: 600 })
  await sleep(4000)
  const after = await evalJs(`[...__field.nodes.values()].length`)
  ok(after >= 1, `new colony drawn after the epoch (${after} specimens)`)
  await shot(phone ? 'phone-epoch' : 'mac-epoch')
  ok(!errors.length, `no page errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`)
} catch (e) {
  console.log('ERROR', e.message)
  process.exitCode = 1
} finally {
  await admin('speed', { speed: 1 }).catch(() => {})
  await admin('bots', { count: 0 }).catch(() => {})
  proc.kill()
}
console.log(`${n} demo checks passed${phone ? ' (phone)' : ' (Mac)'}`)
