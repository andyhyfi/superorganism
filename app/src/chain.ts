import {
  createPublicClient,
  createWalletClient,
  http,
  parseEventLogs,
  type Address,
  type Hex,
} from 'viem'
import { foundry } from 'viem/chains'
import { mnemonicToAccount } from 'viem/accounts'
import { evolutionAbi, usdcAbi } from './abi'
import local from './local.json'

// Local test chain only. The mnemonic is anvil's public test phrase; its accounts hold only
// mock USDC on a chain that exists on this Mac. Nothing here touches a real network.
const MNEMONIC = 'test test test test test test test test test test test junk'
// Same-origin path proxied by the dev server to the chain on this Mac (vite.config.ts),
// so phones on the Wi-Fi can use it too.
const RPC = `${location.origin}/rpc`

export const EVOLUTION = local.evolution as Address
export const USDC = local.usdc as Address
export const PRESET = (local as { preset?: string }).preset ?? 'real'

/** Account 9 plays "you" in the skeleton. Accounts 1 to 8 belong to the activity script. */
export const you = mnemonicToAccount(MNEMONIC, { addressIndex: 9 })

export const publicClient = createPublicClient({ chain: foundry, transport: http(RPC), pollingInterval: 500 })
const wallet = createWalletClient({ account: you, chain: foundry, transport: http(RPC) })

export type Traits = { feePpm: number; rollCapPpm: number; rollMidFill: bigint }
export type LoanRules = { eventChancePpm: number; loanMinSecs: number; loanMaxSecs: number; loansOutCap: number }
export type ChainNode = {
  id: number
  parent: number
  firstChild: number
  depth: number
  split: boolean
  gone: boolean // dissipated: out of the network; any leftover claim stays withdrawable
  total: bigint // own energy: user claims plus rounding fill (real USDC)
  traits: Traits
  loanRules: LoanRules
  lent: bigint // energy out on loan (no USDC moves)
  borrowed: bigint // energy held on loan from other cells
  energy: bigint // what the cell shows: own not lent out, plus borrowed
  rollFill: bigint // what the split roll uses: borrowed counts up to the cell's own (at most 50%)
}

/** One active loan part: energy from `lender` now held by `holder`. */
export type LoanLink = { loanId: number; lender: number; holder: number; amount: bigint; due: number }

export type NetEvent =
  | { kind: 'deposit'; node: number; user: Address; amount: bigint; key: string; block: bigint }
  | { kind: 'withdraw'; node: number; user: Address; amount: bigint; key: string; block: bigint }
  | { kind: 'split'; parent: number; c0: number; c1: number; key: string; block: bigint }
  | { kind: 'loan'; loanId: number; lender: number; borrower: number; amount: bigint; due: number; key: string; block: bigint }
  | { kind: 'repay'; loanId: number; lender: number; key: string; block: bigint }

export async function assertLocalChain() {
  const id = await publicClient.getChainId()
  if (id !== 31337) throw new Error(`Expected the local chain (31337), found ${id}`)
  const code = await publicClient.getCode({ address: EVOLUTION })
  if (!code || code === '0x') throw new Error('No contract at the saved address. Restart ./local.sh, then npm run abi.')
}

/** Every node, with its loan energy, plus the active loan links between live nodes. */
export async function readNodes(): Promise<ChainNode[]> {
  return (await readNetwork()).nodes
}

export async function readNetwork(): Promise<{ nodes: ChainNode[]; links: LoanLink[] }> {
  const count = Number(await publicClient.readContract({ address: EVOLUTION, abi: evolutionAbi, functionName: 'nodeCount' }))
  const ids = Array.from({ length: count }, (_, i) => i)
  const raw = await Promise.all(
    ids.map(id => publicClient.readContract({ address: EVOLUTION, abi: evolutionAbi, functionName: 'getNode', args: [BigInt(id)] })),
  )
  const liveIds = ids.filter(id => !raw[id].split && !raw[id].gone)
  const parts = await Promise.all(
    liveIds.map(id => publicClient.readContract({ address: EVOLUTION, abi: evolutionAbi, functionName: 'loansIn', args: [BigInt(id)] })),
  )
  const links: LoanLink[] = parts.flat().map(l => ({
    loanId: Number(l.loanId), lender: Number(l.lender), holder: Number(l.holder), amount: l.amount, due: Number(l.due),
  }))
  const lent = new Map<number, bigint>(), borrowed = new Map<number, bigint>()
  for (const l of links) {
    lent.set(l.lender, (lent.get(l.lender) ?? 0n) + l.amount)
    borrowed.set(l.holder, (borrowed.get(l.holder) ?? 0n) + l.amount)
  }
  const nodes = raw.map((n, id) => {
    const out = lent.get(id) ?? 0n, inn = borrowed.get(id) ?? 0n
    const base = n.total > out ? n.total - out : 0n
    return {
      id,
      parent: Number(n.parent),
      firstChild: Number(n.firstChild),
      depth: Number(n.depth),
      split: n.split,
      gone: n.gone,
      total: n.total,
      traits: { feePpm: Number(n.traits.feePpm), rollCapPpm: Number(n.traits.rollCapPpm), rollMidFill: n.traits.rollMidFill },
      loanRules: {
        eventChancePpm: Number(n.loanRules.eventChancePpm), loanMinSecs: Number(n.loanRules.loanMinSecs),
        loanMaxSecs: Number(n.loanRules.loanMaxSecs), loansOutCap: Number(n.loanRules.loansOutCap),
      },
      lent: out,
      borrowed: inn,
      energy: base + inn,
      rollFill: base + (inn < base ? inn : base),
    }
  })
  return { nodes, links }
}

/** All contract events in [from, to], in chain order. */
export async function readEvents(from: bigint, to: bigint): Promise<NetEvent[]> {
  if (to < from) return []
  const logs = await publicClient.getLogs({ address: EVOLUTION, fromBlock: from, toBlock: to })
  const parsed = parseEventLogs({ abi: evolutionAbi, logs })
  const out: NetEvent[] = []
  for (const l of parsed) {
    const key = `${l.transactionHash}:${l.logIndex}`
    const block = l.blockNumber ?? 0n
    if (l.eventName === 'Deposited') {
      out.push({ kind: 'deposit', node: Number(l.args.nodeId), user: l.args.user, amount: l.args.amount, key, block })
    } else if (l.eventName === 'Withdrawn') {
      out.push({ kind: 'withdraw', node: Number(l.args.nodeId), user: l.args.user, amount: l.args.amount, key, block })
    } else if (l.eventName === 'Split') {
      out.push({ kind: 'split', parent: Number(l.args.parentId), c0: Number(l.args.child0), c1: Number(l.args.child1), key, block })
    } else if (l.eventName === 'LoanMade') {
      out.push({
        kind: 'loan', loanId: Number(l.args.loanId), lender: Number(l.args.lender), borrower: Number(l.args.borrower),
        amount: l.args.amount, due: Number(l.args.due), key, block,
      })
    } else if (l.eventName === 'LoanRepaid') {
      out.push({ kind: 'repay', loanId: Number(l.args.loanId), lender: Number(l.args.lender), key, block })
    }
  }
  return out
}

export async function feesOwed(): Promise<bigint> {
  return publicClient.readContract({ address: EVOLUTION, abi: evolutionAbi, functionName: 'feesAccrued' })
}

export async function splitOdds(): Promise<bigint> {
  return publicClient.readContract({ address: EVOLUTION, abi: evolutionAbi, functionName: 'splitOdds' })
}

export async function claimOf(node: number): Promise<bigint> {
  return publicClient.readContract({ address: EVOLUTION, abi: evolutionAbi, functionName: 'claimOf', args: [BigInt(node), you.address] })
}

export async function chancesAt(node: number, fill: bigint): Promise<{ roll: bigint; split: bigint }> {
  const [roll, split] = await Promise.all([
    publicClient.readContract({ address: EVOLUTION, abi: evolutionAbi, functionName: 'rollChance', args: [BigInt(node), fill] }),
    publicClient.readContract({ address: EVOLUTION, abi: evolutionAbi, functionName: 'splitChance', args: [BigInt(node), fill] }),
  ])
  return { roll, split }
}

/** Deposit limits and the loan event fee, fixed at deployment. */
export async function limits(): Promise<{ maxDeposit: bigint; maxPerUser: bigint; eventFee: bigint }> {
  const [maxDeposit, maxPerUser, eventFee] = await Promise.all([
    publicClient.readContract({ address: EVOLUTION, abi: evolutionAbi, functionName: 'maxDeposit' }),
    publicClient.readContract({ address: EVOLUTION, abi: evolutionAbi, functionName: 'maxPerUser' }),
    publicClient.readContract({ address: EVOLUTION, abi: evolutionAbi, functionName: 'eventFee' }),
  ])
  return { maxDeposit, maxPerUser, eventFee }
}

/** What you hold in the contract, net of fees, for the per-user limit. */
export async function yourHeld(): Promise<bigint> {
  return publicClient.readContract({ address: EVOLUTION, abi: evolutionAbi, functionName: 'heldOf', args: [you.address] })
}

// ---------------------------------------------------------------- test dials (local only)
// The local deploy is EvolutionDemo: two dials anyone can set. 0 = the real rules.

export type Dials = { splitPpm: number; eventPpm: number }

export async function readDials(): Promise<Dials> {
  const [a, b] = await Promise.all([
    publicClient.readContract({ address: EVOLUTION, abi: evolutionAbi, functionName: 'demoSplitPpm' }),
    publicClient.readContract({ address: EVOLUTION, abi: evolutionAbi, functionName: 'demoEventPpm' }),
  ])
  return { splitPpm: Number(a), eventPpm: Number(b) }
}

export async function setDials(d: Dials) {
  await confirm(await wallet.writeContract({ address: EVOLUTION, abi: evolutionAbi, functionName: 'setDemoDials', args: [d.splitPpm, d.eventPpm] }))
}

/**
 * USDC you deposited minus USDC you withdrew, over all time (before fees), from your own
 * Deposited and Withdrawn logs (the user topic is indexed, so this reads only your events).
 */
export async function yourNetDeposited(): Promise<bigint> {
  const [d, w] = await Promise.all([
    publicClient.getContractEvents({ address: EVOLUTION, abi: evolutionAbi, eventName: 'Deposited', args: { user: you.address }, fromBlock: 0n }),
    publicClient.getContractEvents({ address: EVOLUTION, abi: evolutionAbi, eventName: 'Withdrawn', args: { user: you.address }, fromBlock: 0n }),
  ])
  const sum = (xs: readonly { args: unknown }[]) => xs.reduce((a, l) => a + ((l.args as { amount?: bigint }).amount ?? 0n), 0n)
  const net = sum(d) - sum(w)
  return net > 0n ? net : 0n
}

export async function yourWallet(): Promise<bigint> {
  return publicClient.readContract({ address: USDC, abi: usdcAbi, functionName: 'balanceOf', args: [you.address] })
}

/** Where a transaction is: waiting on the wallet for approval, or sent and waiting for its receipt. */
export type Stage = (s: 'approving' | 'confirming') => void
const noStage: Stage = () => {}

async function confirm(hash: Hex, stage: Stage = noStage) {
  stage('confirming')
  const r = await publicClient.waitForTransactionReceipt({ hash })
  if (r.status !== 'success') throw new Error('Transaction reverted')
}

let approved = false
async function ensureApproval(stage: Stage = noStage) {
  if (approved) return
  const allowance = await publicClient.readContract({
    address: USDC, abi: usdcAbi, functionName: 'allowance', args: [you.address, EVOLUTION],
  })
  if (allowance < 10n ** 15n) {
    stage('approving')
    await confirm(await wallet.writeContract({ address: USDC, abi: usdcAbi, functionName: 'approve', args: [EVOLUTION, 2n ** 255n] }), stage)
  }
  approved = true
}

export async function deposit(node: number, amount: bigint, stage: Stage = noStage) {
  await ensureApproval(stage)
  await confirm(await wallet.writeContract({ address: EVOLUTION, abi: evolutionAbi, functionName: 'deposit', args: [BigInt(node), amount] }), stage)
}

export async function withdrawWhole(node: number, stage: Stage = noStage) {
  await confirm(await wallet.writeContract({ address: EVOLUTION, abi: evolutionAbi, functionName: 'withdrawAll', args: [[BigInt(node)]] }), stage)
}

/** Withdraws `amount` of your claim from one node (the whole claim if amount equals it). */
export async function withdrawAmount(node: number, amount: bigint, claim: bigint, stage: Stage = noStage) {
  if (amount >= claim) return withdrawWhole(node, stage)
  await confirm(await wallet.writeContract({ address: EVOLUTION, abi: evolutionAbi, functionName: 'withdraw', args: [BigInt(node), amount] }), stage)
}

/** Your claims on the given nodes, in order. */
export async function claimsOf(ids: number[]): Promise<bigint[]> {
  return Promise.all(ids.map(id => claimOf(id)))
}

/** Withdraws every listed claim, in batches of 50 (the contract's cap per call). */
export async function withdrawEverything(ids: number[], stage: Stage = noStage) {
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50).map(BigInt)
    await confirm(await wallet.writeContract({ address: EVOLUTION, abi: evolutionAbi, functionName: 'withdrawAll', args: [batch] }), stage)
  }
}

export const USDC_UNIT = 1_000_000n
export const usd = (x: bigint) => Number(x) / 1e6
