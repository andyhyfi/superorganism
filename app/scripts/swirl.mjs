// Swirl check: steps the field directly in headless Chrome and prints rotation, packing,
// breath-out after a split, and overlaps. Dev tool only. Usage: node scripts/swirl.mjs
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 9334
const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--user-data-dir=' + process.env.TMPDIR + '/swirl-profile', '--window-size=1728,1117', 'about:blank'], { stdio: 'ignore' })
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
  const out = await evalJs(`(async () => {
    const f=__field; f.stop();
    const live=()=>[...f.nodes.values()].filter(n=>!n.splitting && n.total>0.000001);
    const meanR=()=>{const l=live(); return l.reduce((a,n)=>a+Math.hypot(n.x,n.y),0)/l.length};
    const gap=()=>{const l=live(); let g=0; for(const a of l){let m=1e9; for(const b of l) if(a!==b) m=Math.min(m,Math.hypot(a.x-b.x,a.y-b.y)-a.r-b.r); g+=m} return g/l.length};
    const hole=()=>{const l=live(); let m=1e9; for(const n of l) m=Math.min(m,Math.hypot(n.x,n.y)-n.r); return m};
    const angs=()=>new Map(live().map(n=>[n.id,Math.atan2(n.y,n.x)]));
    const overlap=()=>{let k=0; const l=[...f.nodes.values()].filter(n=>!n.splitting); for(let i=0;i<l.length;i++)for(let j=i+1;j<l.length;j++){if(Math.hypot(l[i].x-l[j].x,l[i].y-l[j].y)<l[i].r+l[j].r-1)k++} return k};
    const step=n=>{for(let i=0;i<n;i++){f.t+=1/60; f.step(1/60)}};
    step(60*60);
    const a0=angs(), r0=meanR(), g0=gap(), h0=hole();
    step(60*20);
    const a1=angs(); let ds=0,c=0;
    for(const [id,a] of a0) if(a1.has(id)){let d=a1.get(id)-a; ds+=Math.atan2(Math.sin(d),Math.cos(d)); c++}
    const deg=ds/c/20*180/Math.PI;
    const id=live()[0].id; f.apply([{kind:'split', parent:id, c0:9001, c1:9002, key:'t', block:0n}]);
    const trace=[]; let maxOv=0;
    for(let s=0;s<60;s++){step(60); maxOv=Math.max(maxOv,overlap()); if(s%5==4) trace.push(Math.round(meanR()))}
    return JSON.stringify({cells:live().length, degPerSec:+deg.toFixed(2), lapMin:+(360/Math.abs(deg)/60).toFixed(1), clockwise:deg>0, meanDistFromCenter:Math.round(r0), meanGapToNearest:Math.round(g0), emptyCenterRadius:Math.round(h0), afterSplitEvery5s:trace, maxOverlaps:maxOv});
  })()`)
  console.log(out)
} finally { ws?.close(); proc.kill() }
