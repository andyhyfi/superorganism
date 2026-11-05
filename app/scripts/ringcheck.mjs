// Ring check: empties 4 cells, measures where they wait (gap from the cluster edge), then
// revives one and traces its gap as it drifts back in. Dev tool only. Usage: node scripts/ringcheck.mjs
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 9336
const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--user-data-dir=' + process.env.TMPDIR + '/ring-profile', '--window-size=1728,1117', 'about:blank'], { stdio: 'ignore' })
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
    const step=n=>{for(let i=0;i<n;i++){f.t+=1/60; f.step(1/60)}};
    const all=()=>[...f.nodes.values()].filter(n=>!n.splitting);
    const live=()=>all().filter(n=>n.total>0.000001), empty=()=>all().filter(n=>n.total<=0.000001);
    // make 4 small cells empty, as a full withdrawal would
    const small=live().sort((a,b)=>a.r-b.r).slice(0,4); for(const n of small) n.total=0;
    step(60*60);
    const edge=()=>Math.max(...live().map(n=>Math.hypot(n.x,n.y)+n.r));
    const ring=empty().map(n=>Math.round(Math.hypot(n.x,n.y)-n.r-edge()));
    // revive one: a deposit or a loan gives it energy again
    const back=empty().sort((a,b)=>Math.hypot(b.x,b.y)-Math.hypot(a.x,a.y))[0]; back.total=5;
    const edgeX=()=>Math.max(...live().filter(n=>n!==back).map(n=>Math.hypot(n.x,n.y)+n.r));
    const trace=[]; for(let s=0;s<40;s++){ step(60); if(s%4==3) trace.push(Math.round(Math.hypot(back.x,back.y)-back.r-edgeX())) }
    let ov=0; const l=all(); for(let i=0;i<l.length;i++)for(let j=i+1;j<l.length;j++) if(Math.hypot(l[i].x-l[j].x,l[i].y-l[j].y)<l[i].r+l[j].r-1) ov++;
    return JSON.stringify({live:live().length, emptyGapsFromClusterEdge:ring, revivedGapEvery4s:trace, overlaps:ov});
  })()`)
  console.log(out)
} finally { ws?.close(); proc.kill() }
