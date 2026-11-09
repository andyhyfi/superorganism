// Every transition of the pure state machines. Run: node --experimental-strip-types scripts/machines.test.ts
import { tx, txIdle, txBusy, link, linkStart, linkDown, LOST_AFTER, notice, type Tx, type Link, type Notice } from '../src/machines.ts'

let n = 0
function eq(a: unknown, b: unknown, what: string) {
  const sa = JSON.stringify(a, (_, v) => (typeof v === 'bigint' ? `${v}n` : v))
  const sb = JSON.stringify(b, (_, v) => (typeof v === 'bigint' ? `${v}n` : v))
  if (sa !== sb) { console.error(`FAIL ${what}\n  got  ${sa}\n  want ${sb}`); process.exit(1) }
  n++
}

// transaction
let t: Tx = txIdle
eq(txBusy(t), null, 'idle is not busy')
t = tx(t, { type: 'stage', stage: 'confirming' })
eq(t, txIdle, 'stage while idle is ignored')
t = tx(t, { type: 'start', kind: 'deposit' })
eq(t, { phase: 'sending', kind: 'deposit' }, 'start')
eq(tx(t, { type: 'start', kind: 'withdraw' }), t, 'second start while busy is ignored (no double send)')
t = tx(t, { type: 'stage', stage: 'approving' })
eq(t, { phase: 'approving', kind: 'deposit' }, 'approving keeps the kind')
t = tx(t, { type: 'stage', stage: 'confirming' })
eq(txBusy(t), 'deposit', 'busy reads the kind')
t = tx(t, { type: 'end' })
eq(t, txIdle, 'end returns to idle')
eq(tx(txIdle, { type: 'end' }), txIdle, 'end while idle stays idle')

// link
let l: Link = linkStart
eq(link(l, { type: 'miss' }), linkStart, 'a miss while connecting changes nothing (boot reports its own failure)')
l = link(l, { type: 'ok', block: 5n })
eq(l, { phase: 'live', block: 5n }, 'first good poll')
for (let i = 1; i <= LOST_AFTER; i++) {
  l = link(l, { type: 'miss' })
  eq(l, { phase: 'lost', misses: i, block: 5n }, `miss ${i} keeps the last block`)
  eq(linkDown(l), i >= LOST_AFTER, `down only after ${LOST_AFTER} misses (miss ${i})`)
}
l = link(l, { type: 'ok', block: 9n })
eq(l, { phase: 'live', block: 9n }, 'recovers')
l = link(l, { type: 'fail', error: 'x' })
eq(link(l, { type: 'ok', block: 10n }), l, 'failed is terminal')

// notice
let s: Notice = null
s = notice(s, { type: 'show', text: 'a' })
const first = s!.id
s = notice(s, { type: 'show', text: 'b' })
eq(notice(s, { type: 'expire', id: first })?.text, 'b', 'an old timer cannot clear a newer message')
eq(notice(s, { type: 'expire', id: s!.id }), null, 'its own timer clears it')
s = notice(s, { type: 'show', text: 'c', sticky: true })
eq(notice(s, { type: 'expire', id: s!.id })?.text, 'c', 'sticky ignores timers')
eq(notice(s, { type: 'clearSticky' }), null, 'clearSticky clears a sticky')
eq(notice(notice(null, { type: 'show', text: 'd' }), { type: 'clearSticky' })?.text, 'd', 'clearSticky leaves a normal message')

console.log(`machines: ${n} checks passed`)
