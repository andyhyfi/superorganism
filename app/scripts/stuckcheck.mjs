// Stuck check: forces 12 splits and reports the worst live-cell overlap and how long any pair
// stays overlapped. Dev tool only. Usage: node scripts/stuckcheck.mjs
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 9337
const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--user-data-dir=' + process.env.TMPDIR + '/stuck-profile', '--window-size=1728,1117', 'about:blank'], { stdio: 'ignore' })
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
    const step1=()=>{f.t+=1/60; f.step(1/60)};
    for(let i=0;i<60*20;i++) step1();
    // stress: 12 splits, one every 3 s, smallest and largest cells alike; watch live-live overlaps
    const live=()=>[...f.nodes.values()].filter(n=>!n.splitting && n.total>0.000001);
    const every=()=>[...f.nodes.values()];
    let next=90001, worst=0, longest=0; const run=new Map(); const stuck=[];
    for(let k=0;k<12;k++){
      const l=live().sort((a,b)=>a.r-b.r); const pick=k%2? l[l.length-1-k] : l[k];
      if(k%4==1){ const e=live().sort((a,b)=>a.r-b.r)[3]; e.total=0 }
      f.apply([{kind:'split', parent:pick.id, c0:next, c1:next+1, key:'s'+k, block:0n}]); next+=2;
      for(let i=0;i<180;i++){
        step1();
        const L=every();
        for(let a=0;a<L.length;a++) for(let b=a+1;b<L.length;b++){
          const A=L[a],B=L[b], ov=f.reach(A)+f.reach(B)-0.06*(A.r+B.r)-Math.hypot(A.x-B.x,A.y-B.y);
          const key=A.id+'-'+B.id;
          if(ov>2){ worst=Math.max(worst,ov); const c=(run.get(key)||0)+1; run.set(key,c); if(c>longest){longest=c; stuck.length=0; stuck.push({small:Math.round(Math.min(A.r,B.r)), big:Math.round(Math.max(A.r,B.r)), ov:Math.round(ov), emptyA:A.total<=0.000001, emptyB:B.total<=0.000001, splitA:!!A.splitting, splitB:!!B.splitting})} }
          else run.delete(key);
        }
      }
    }
    for(let i=0;i<60*10;i++) step1();
    let end=0; const L=every(); for(let a=0;a<L.length;a++) for(let b=a+1;b<L.length;b++) if(L[a].r+L[b].r-Math.hypot(L[a].x-L[b].x,L[a].y-L[b].y)>2) end++;
    const emptyN=L.filter(n=>n.total<=0.000001).length;
    return JSON.stringify({cells:L.length, worstOverlapPx:Math.round(worst), longestStuckSeconds:+(longest/60).toFixed(1), example:stuck[0], overlapsAtEnd:end, empty:emptyN});
  })()`)
  console.log(out)
} finally { ws?.close(); proc.kill() }
