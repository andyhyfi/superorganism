// Gentle background activity for the local chain, so the field lives on its own.
// Accounts 1 to 8 of anvil's public test mnemonic deposit and withdraw at random, every few
// seconds. Local chain only: refuses to run against anything but chain 31337.
//
//   npm run activity            default pace
//   PACE=fast npm run activity  about three times as busy
import { createPublicClient, createWalletClient, http, parseEventLogs } from 'viem'
import { foundry } from 'viem/chains'
import { mnemonicToAccount } from 'viem/accounts'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const local = JSON.parse(readFileSync(join(here, '..', 'src', 'local.json'), 'utf8'))
const { evolutionAbi, usdcAbi } = await import('./abi-node.mjs')

const MNEMONIC = 'test test test test test test test test test test test junk'
const RPC = 'http://127.0.0.1:8545'
const fast = process.env.PACE === 'fast'
const GAP = fast ? [700, 2200] : [2500, 7000] // ms between actions
const MAX_LIVE_NODES = Number(process.env.MAX_CELLS || 80) // above this, activity only withdraws (Andy: the network will grow well past 20)

const pub = createPublicClient({ chain: foundry, transport: http(RPC) })
if ((await pub.getChainId()) !== 31337) throw new Error('activity.mjs runs on the local chain only')

// Account 11 plays the randomness operator (Gelato VRF on Ink): it answers each loan event
// request with a random number, a few seconds later.
const opAccount = mnemonicToAccount(MNEMONIC, { addressIndex: 11 })
const operator = createWalletClient({ account: opAccount, chain: foundry, transport: http(RPC) })
let answered = 0n
async function answerRequests() {
  try {
    const pending = await pub.readContract({ address: local.evolution, abi: evolutionAbi, functionName: 'pendingRequest' })
    if (pending !== 0n && pending !== answered) {
      await sleep(rand(1500, 4000))
      const r = BigInt('0x' + [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join(''))
      const hash = await operator.writeContract({ address: local.evolution, abi: evolutionAbi, functionName: 'runLoanEvent', args: [pending, r] })
      const receipt = await pub.waitForTransactionReceipt({ hash })
      answered = pending
      const logs = parseEventLogs({ abi: evolutionAbi, logs: receipt.logs })
      const made = logs.filter(l => l.eventName === 'LoanMade')
      const splits = logs.filter(l => l.eventName === 'Split')
      console.log(`event     #${pending}  ${made.map(l => `${l.args.lender}->${l.args.borrower} ${usd(l.args.amount)}`).join(', ') || 'no sends'}${splits.length ? `  SPLIT x${splits.length}` : ''}`)
    }
  } catch (e) {
    console.log('event skip:', (e?.shortMessage || e?.message || String(e)).split('\n')[0])
  }
}
let answering = false
setInterval(async () => {
  if (answering) return
  answering = true
  await answerRequests()
  answering = false
}, 1000)

const actors = Array.from({ length: 8 }, (_, i) => {
  const account = mnemonicToAccount(MNEMONIC, { addressIndex: i + 1 })
  return { account, wallet: createWalletClient({ account, chain: foundry, transport: http(RPC) }) }
})

const E = local.evolution, U = local.usdc
const rand = (a, b) => a + Math.random() * (b - a)
const pickOne = xs => xs[Math.floor(Math.random() * xs.length)]
const sleep = ms => new Promise(r => setTimeout(r, ms))

// One-time approvals.
for (const a of actors) {
  const allowance = await pub.readContract({ address: U, abi: usdcAbi, functionName: 'allowance', args: [a.account.address, E] })
  if (allowance < 10n ** 15n) {
    const hash = await a.wallet.writeContract({ address: U, abi: usdcAbi, functionName: 'approve', args: [E, 2n ** 255n] })
    await pub.waitForTransactionReceipt({ hash })
  }
}

async function liveNodes() {
  const count = Number(await pub.readContract({ address: E, abi: evolutionAbi, functionName: 'nodeCount' }))
  const nodes = await Promise.all(
    Array.from({ length: count }, (_, i) =>
      pub.readContract({ address: E, abi: evolutionAbi, functionName: 'getNode', args: [BigInt(i)] }).then(n => ({ id: i, ...n })),
    ),
  )
  return nodes.filter(n => !n.split)
}

const usd = x => (Number(x) / 1e6).toFixed(2)
console.log(`activity: ${actors.length} accounts, ${fast ? 'fast' : 'gentle'} pace. Ctrl+C stops.`)

while (true) {
  try {
    const live = await liveNodes()
    const a = pickOne(actors)
    const crowded = live.length >= MAX_LIVE_NODES
    if (crowded || Math.random() < 0.2) {
      // withdraw a whole claim somewhere this actor holds one
      const claims = await Promise.all(
        live.map(n => pub.readContract({ address: E, abi: evolutionAbi, functionName: 'claimOf', args: [BigInt(n.id), a.account.address] }).then(c => ({ id: n.id, c }))),
      )
      const held = claims.filter(x => x.c > 0n)
      if (held.length) {
        const { id, c } = pickOne(held)
        const hash = await a.wallet.writeContract({ address: E, abi: evolutionAbi, functionName: 'withdrawAll', args: [[BigInt(id)]] })
        await pub.waitForTransactionReceipt({ hash })
        console.log(`withdraw  node ${String(id).padStart(3)}  ${usd(c).padStart(9)}  acct ${actors.indexOf(a) + 1}`)
      }
    } else {
      // deposit, leaning toward bigger nodes
      const w = live.map(n => 1 + Number(n.total) / 200e6)
      let r = Math.random() * w.reduce((x, y) => x + y, 0), node = live[0]
      for (let i = 0; i < live.length; i++) { r -= w[i]; if (r <= 0) { node = live[i]; break } }
      // stay under the 1,000 USDC per-user limit: withdraw instead when near it
      const held = await pub.readContract({ address: E, abi: evolutionAbi, functionName: 'heldOf', args: [a.account.address] })
      const amount = BigInt(Math.round((Math.random() < 0.85 ? rand(1, 40) : rand(60, 160)) * 1e6))
      if (held + amount > 1_000_000_000n) { await sleep(500); continue }
      const hash = await a.wallet.writeContract({ address: E, abi: evolutionAbi, functionName: 'deposit', args: [BigInt(node.id), amount] })
      const receipt = await pub.waitForTransactionReceipt({ hash })
      const split = parseEventLogs({ abi: evolutionAbi, logs: receipt.logs }).find(l => l.eventName === 'Split')
      console.log(`deposit   node ${String(node.id).padStart(3)}  ${usd(amount).padStart(9)}  acct ${actors.indexOf(a) + 1}${split ? `  SPLIT -> ${split.args.child0}, ${split.args.child1}` : ''}`)
    }
  } catch (e) {
    console.log('skip:', (e?.shortMessage || e?.message || String(e)).split('\n')[0])
  }
  await sleep(rand(GAP[0], GAP[1]))
}
