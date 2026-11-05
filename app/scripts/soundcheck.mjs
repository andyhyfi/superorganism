// Sound check: clicks the sound button, then measures the level (RMS, peak) of the ambience and
// each effect, and the rate limit. Dev tool only. Usage: node scripts/soundcheck.mjs
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 9338
const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--user-data-dir=' + process.env.TMPDIR + '/sound-profile', '--window-size=1728,1117', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' })
let ws, id = 0
const pending = new Map()
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const evalJs = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value
try {
  let target
  for (let k = 0; k < 50 && !target; k++) { await sleep(200); try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find(t => t.type === 'page') } catch {} }
  ws = new WebSocket(target.webSocketDebuggerUrl)
  ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id) } }
  await new Promise(r => (ws.onopen = r))
  await send('Emulation.setDeviceMetricsOverride', { width: 1728, height: 1117, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: 'http://127.0.0.1:5173/' })
  await sleep(8000)
  // a real click on the sound button (a user gesture, so audio may start)
  await evalJs(`(() => { document.querySelector('.controls').classList.remove('hidden'); return 1 })()`)
  const box = JSON.parse(await evalJs(`JSON.stringify((r=>({x:r.left+r.width/2,y:r.top+r.height/2}))(document.querySelector('.controls [aria-pressed]').getBoundingClientRect()))`))
  await evalJs(`(() => { const c=document.querySelector('.controls'); c.style.pointerEvents='auto'; return 1 })()`)
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await sleep(1500)
  const out = await evalJs(`(async () => {
    const s=__sound, ctx=s.ctx;
    const toggle = {on:s.on, state:ctx?.state, saved:localStorage.getItem('evolution.sound'), btn: document.querySelector('.controls [aria-pressed]')?.getAttribute('aria-label')};
    if (!ctx) return JSON.stringify({toggle});
    const an = ctx.createAnalyser(); an.fftSize=4096; s.out.connect(an);
    const buf = new Float32Array(an.fftSize);
    const lvl = () => { an.getFloatTimeDomainData(buf); let a=0,pk=0; for(const v of buf){a+=v*v; pk=Math.max(pk,Math.abs(v))} return [+Math.sqrt(a/buf.length).toFixed(4), +pk.toFixed(3)] };
    const wait = ms => new Promise(r=>setTimeout(r,ms));
    await wait(3000);
    const out = {toggle, bed: lvl()};
    for (const k of ['deposit','withdraw','split','loan','repay']) {
      s.recent=[]; s.play(k, 0, 3, 7); await wait(200);
      out[k] = lvl(); await wait(2200);
    }
    s.recent=[]; for(let i=0;i<20;i++) s.play('deposit',0,i); out.limitedTo = s.recent.length;
    return JSON.stringify(out);
  })()`)
  console.log(out)
} finally { ws?.close(); proc.kill() }
