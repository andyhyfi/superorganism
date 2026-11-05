// Split check: forces a split in the live field and prints, per tenth of a second, how fast the
// two halves move apart and how far a neighbor is pushed, by size. Dev tool only.
// Usage: node scripts/splitcheck.mjs
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 9335
const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--user-data-dir=' + process.env.TMPDIR + '/split-profile', '--window-size=1728,1117', 'about:blank'], { stdio: 'ignore' })
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
  await send('Page.navigate', { url: 'http://127.0.0.1:5173/' })
  await sleep(8000)
  const out = await evalJs(`(() => {
    const f=__field; f.stop();
    const step=n=>{for(let i=0;i<n;i++){f.t+=1/60; f.step(1/60)}};
    step(60*30);
    const live=[...f.nodes.values()].filter(n=>!n.splitting && n.total>0.000001).sort((a,b)=>b.r-a.r);
    const big=live[0];
    // speed profile of the lobe gap during the pinch and after hand-off
    const others=live.filter(n=>n!==big).map(n=>({n, x:n.x, y:n.y, d:Math.hypot(n.x-big.x,n.y-big.y)-n.r-big.r})).sort((p,q)=>p.d-q.d);
    const near=others.slice(0,4), far=others.slice(-4);
    f.apply([{kind:'split', parent:big.id, c0:9001, c1:9002, key:'t', block:0n}]);
    const ang=big.splitting.ang, r0=big.r, T=2.6;
    const gap=[];
    for(let i=0;i<=60*5;i+=6){
      let sep;
      if(f.nodes.has(big.id) && big.splitting){
        const raw=Math.min(1,big.splitting.p), rc=r0*(1-(raw<0.5?4*raw**3:1-(-2*raw+2)**3/2)*(1-Math.SQRT1_2));
        const k=Math.max(1.6,Math.min(3,(70*T)/(r0*Math.SQRT1_2*(1.03+3/(2*r0*Math.SQRT1_2)))));
        sep=2*rc*Math.pow(raw,k)*(1.03+3/(2*rc));
      } else { const a=f.nodes.get(9001), b=f.nodes.get(9002); sep=a&&b?Math.hypot(a.x-b.x,a.y-b.y):NaN }
      gap.push(+sep.toFixed(1)); step(6);
    }
    const speed=gap.slice(1).map((g,i)=>Math.round((g-gap[i])*10));
    const moved=g=>Math.round(g.reduce((a,o)=>a+Math.hypot(o.n.x-o.x,o.n.y-o.y),0)/g.length);
    const nearMoved=moved(near), farMoved=moved(far);
    // collisions: two cells alone in open water, the big one sent at the small one
    const a=live[1], b=live[live.length-1];
    // neighbors of the split cell: how far they were moved over the 2.6 s split (no network-wide jump)
    for(const [k,n] of [...f.nodes]) if(n!==a && n!==b) f.nodes.delete(k); f.links=[]; // only the two cells remain
    b.x=0; b.y=0; a.x=-(a.r*1.03+b.r*1.03+3+3); a.y=0; a.vx=60; a.vy=0; b.vx=0; b.vy=0;
    f.pulse=0; step(10);
    const av=Math.round(a.vx), bv=Math.round(b.vx);
    return JSON.stringify({bigR:Math.round(r0), neighborsMoved:{nearest4:nearMoved, farthest4:farMoved}, separationSpeedPerTenth: speed, collision:{bigR:Math.round(a.r), bigSpeedBefore:60, bigSpeedAfter:av, smallR:Math.round(b.r), smallSpeedAfter:bv}});
  })()`)
  console.log(out)
} finally { ws?.close(); proc.kill() }
