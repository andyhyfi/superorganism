// Camera check: follows the largest cell, splits it, and reports where the selection went and the
// camera's peak speed, acceleration and zoom rate (lower = smoother). Usage: node scripts/camcheck.mjs
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 9339
const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--user-data-dir=' + process.env.TMPDIR + '/cam-profile', '--window-size=1728,1117', 'about:blank'], { stdio: 'ignore' })
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
    // select the largest cell and follow it, as a tap would; let the camera settle
    const big=[...f.nodes.values()].filter(n=>!n.splitting && n.total>0.000001).sort((a,b)=>b.r-a.r)[0];
    f.selected=big.id; f.focus(big.id);
    for(let i=0;i<60*8;i++) step1();
    let moved=null; f.onSelectionMoved=id=>{moved=id};
    // split it; measure camera speed changes (jerk) per frame in screen pixels, and zoom changes
    f.apply([{kind:'split', parent:big.id, c0:90001, c1:90002, key:'cam', block:0n}]);
    let px=f.cam.x, py=f.cam.y, pz=f.cam.z, pvx=0, pvy=0, maxAcc=0, maxSpeed=0, maxZoomStep=0;
    for(let i=0;i<60*8;i++){
      step1();
      const vx=(f.cam.x-px)*60*f.cam.z, vy=(f.cam.y-py)*60*f.cam.z; // screen px per second
      const acc=Math.hypot(vx-pvx, vy-pvy)*60; // screen px per second squared
      if(i>0) maxAcc=Math.max(maxAcc,acc);
      maxSpeed=Math.max(maxSpeed,Math.hypot(vx,vy));
      maxZoomStep=Math.max(maxZoomStep, Math.abs(Math.log(f.cam.z/pz))*60);
      px=f.cam.x; py=f.cam.y; pz=f.cam.z; pvx=vx; pvy=vy;
    }
    return JSON.stringify({selectedAfter:f.selected, callbackTo:moved, following:f.follow, maxSpeedPxPerS:Math.round(maxSpeed), maxAccelPxPerS2:Math.round(maxAcc), maxZoomPerS:+maxZoomStep.toFixed(3)});
  })()`)
  console.log(out)
} finally { ws?.close(); proc.kill() }
