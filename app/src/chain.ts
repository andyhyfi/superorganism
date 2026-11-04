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
const RPC = 'http://127.0.0.1:8545'

export const EVOLUTION = local.evolution as Address
export const USDC = local.usdc as Address
export const PRESET = (local as { preset?: string }).preset ?? 'real'

/** Account 9 plays "you" in the skeleton. Accounts 1 to 8 belong to the activity script. */
export const you = mnemonicToAccount(MNEMONIC, { addressIndex: 9 })

export const publicClient = createPublicClient({ chain: foundry, transport: http(RPC), pollingInterval: 500 })
const wallet = createWalletClient({ account: you, chain: foundry, transport: http(RPC) })

export type Traits = { feePpm: number; rollCapPpm: number; rollMidFill: bigint }
export type ChainNode = {
  id: number
  parent: number
  firstChild: number
  depth: number
  split: boolean
  total: bigint
  traits: Traits
}

export type NetEvent =
  | { kind: 'deposit'; node: number; user: Address; amount: bigint; key: string }
  | { kind: 'withdraw'; node: number; user: Address; amount: bigint; key: string }
  | { kind: 'split'; parent: number; c0: number; c1: number; key: string }

export async function assertLocalChain() {
  const id = await publicClient.getChainId()
  if (id !== 31337) throw new Error(`Expected the local chain (31337), found ${id}`)
  const code = await publicClient.getCode({ address: EVOLUTION })
  if (!code || code === '0x') throw new Error('No contract at the saved address. Restart ./local.sh, then npm run abi.')
}

export async function readNodes(): Promise<ChainNode[]> {
  const count = Number(await publicClient.readContract({ address: EVOLUTION, abi: evolutionAbi, functionName: 'nodeCount' }))
  const ids = Array.from({ length: count }, (_, i) => i)
  const raw = await Promise.all(
    ids.map(id => publicClient.readContract({ address: EVOLUTION, abi: evolutionAbi, functionName: 'getNode', args: [BigInt(id)] })),
  )
  return raw.map((n, id) => ({
    id,
    parent: Number(n.parent),
    firstChild: Number(n.firstChild),
    depth: Number(n.depth),
    split: n.split,
    total: n.total,
    traits: { feePpm: Number(n.traits.feePpm), rollCapPpm: Number(n.traits.rollCapPpm), rollMidFill: n.traits.rollMidFill },
  }))
}

/** All contract events in [from, to], in chain order. */
export async function readEvents(from: bigint, to: bigint): Promise<NetEvent[]> {
  if (to < from) return []
  const logs = await publicClient.getLogs({ address: EVOLUTION, fromBlock: from, toBlock: to })
  const parsed = parseEventLogs({ abi: evolutionAbi, logs })
  const out: NetEvent[] = []
  for (const l of parsed) {
    const key = `${l.transactionHash}:${l.logIndex}`
    if (l.eventName === 'Deposited') {
      out.push({ kind: 'deposit', node: Number(l.args.nodeId), user: l.args.user, amount: l.args.amount, key })
    } else if (l.eventName === 'Withdrawn') {
      out.push({ kind: 'withdraw', node: Number(l.args.nodeId), user: l.args.user, amount: l.args.amount, key })
    } else if (l.eventName === 'Split') {
      out.push({ kind: 'split', parent: Number(l.args.parentId), c0: Number(l.args.child0), c1: Number(l.args.child1), key })
    }
  }
  return out
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

export async function yourWallet(): Promise<bigint> {
  return publicClient.readContract({ address: USDC, abi: usdcAbi, functionName: 'balanceOf', args: [you.address] })
}

async function confirm(hash: Hex) {
  const r = await publicClient.waitForTransactionReceipt({ hash })
  if (r.status !== 'success') throw new Error('Transaction reverted')
}

let approved = false
async function ensureApproval() {
  if (approved) return
  const allowance = await publicClient.readContract({
    address: USDC, abi: usdcAbi, functionName: 'allowance', args: [you.address, EVOLUTION],
  })
  if (allowance < 10n ** 15n) {
    await confirm(await wallet.writeContract({ address: USDC, abi: usdcAbi, functionName: 'approve', args: [EVOLUTION, 2n ** 255n] }))
  }
  approved = true
}

export async function deposit(node: number, amount: bigint) {
  await ensureApproval()
  await confirm(await wallet.writeContract({ address: EVOLUTION, abi: evolutionAbi, functionName: 'deposit', args: [BigInt(node), amount] }))
}

export async function withdrawWhole(node: number) {
  await confirm(await wallet.writeContract({ address: EVOLUTION, abi: evolutionAbi, functionName: 'withdrawAll', args: [[BigInt(node)]] }))
}

export const USDC_UNIT = 1_000_000n
export const usd = (x: bigint) => Number(x) / 1e6
