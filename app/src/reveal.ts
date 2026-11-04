// Every piece of information the interface can show, in one place.
//
// Each entry has:
//   label  the words on screen. PLACEHOLDERS: the real copy is part of the game's story and is
//          still to be written. Change words here only; components never hard-code them.
//   rule   when the player gets to see it. Hidden entries are not rendered at all.
//
// Rules are data so they can be tuned without touching components:
//   { always: true }                  core: always visible
//   { never: true }                   built but hidden for now
//   { heldHere: n }                   player holds at least n USDC in this cell
//   { heldTotal: n }                  player holds at least n USDC across the network
//   { deposits: n }                   player has made at least n deposits
//   { trait: 'name' }                 the cell carries a mutation (none exist yet, so hidden)
//   { any: [rules] } / { all: [rules] }
//
// Dev only: ?reveal=all in the URL (or the R key) shows everything, to see the whole layout.

export type Rule =
  | { always: true }
  | { never: true }
  | { heldHere: number }
  | { heldTotal: number }
  | { deposits: number }
  | { trait: string }
  | { any: Rule[] }
  | { all: Rule[] }

export type Ctx = {
  heldHere: number // USDC the player holds in the cell being viewed
  heldTotal: number // USDC the player holds across the network
  deposits: number // deposits the player has made
  traits: string[] // mutations on the cell being viewed
}

type Entry = { label: string; rule: Rule; note?: string }

export const INFO = {
  // tabs
  'tab.node': { label: 'Node', rule: { always: true } },
  'tab.network': { label: 'Network', rule: { always: true } },
  'tab.yours': { label: 'Yours', rule: { always: true } },
  'tab.activity': { label: 'Activity', rule: { always: true } },

  // a cell
  'cell.balance': { label: 'Balance', rule: { always: true } },
  'cell.yourShare': { label: 'Yours', rule: { heldHere: 0.000001 } },
  'cell.showOnMap': { label: 'Show on map', rule: { always: true } },
  'cell.divideChance': { label: 'Chance this cell divides', rule: { heldHere: 10 }, note: 'placeholder gate' },
  'cell.fillCheck': { label: 'Fill check', rule: { heldHere: 100 }, note: 'placeholder gate' },
  'cell.divideOdds': { label: 'Then divides', rule: { heldHere: 100 }, note: 'placeholder gate' },
  'cell.divideExplainer': {
    label: 'Fuller cells are more likely to divide. When one does, every balance in it is split evenly between the two new cells.',
    rule: { heldHere: 10 },
  },
  'cell.generation': { label: 'Generation', rule: { deposits: 3 }, note: 'placeholder gate' },
  'cell.fee': { label: 'Fee', rule: { always: true }, note: 'money rule: keep visible' },
  'cell.minimum': { label: 'Minimum', rule: { always: true }, note: 'money rule: keep visible' },
  'cell.lineage': { label: 'Lineage', rule: { heldTotal: 50 }, note: 'placeholder gate' },
  'cell.lineageExplainer': { label: 'Each cell came from its parent dividing.', rule: { heldTotal: 50 } },
  'cell.traits': { label: 'Mutations', rule: { trait: 'any' }, note: 'appears once mutations exist' },

  // actions (money in and out is never hidden)
  'act.amount': { label: 'Amount', rule: { always: true } },
  'act.deposit': { label: 'Deposit', rule: { always: true } },
  'act.depositing': { label: 'Depositing…', rule: { always: true } },
  'act.withdraw': { label: 'Withdraw', rule: { always: true } },
  'act.withdrawing': { label: 'Withdrawing…', rule: { always: true } },
  'act.withdrawAll': { label: 'Withdraw all', rule: { always: true } },
  'act.max': { label: 'Max', rule: { always: true } },

  // the network
  'net.held': { label: 'Held across the network', rule: { always: true } },
  'net.counts': { label: 'cells', rule: { always: true } },
  'net.splits': { label: 'splits', rule: { deposits: 1 } },
  'net.generations': { label: 'generations', rule: { heldTotal: 50 } },
  'net.list': { label: 'All cells', rule: { always: true } },
  'net.sort': { label: 'Sort', rule: { deposits: 1 } },
  'net.fees': { label: 'Fees collected', rule: { heldTotal: 500 }, note: 'placeholder gate' },

  // the player
  'you.balance': { label: 'Your balance in the network', rule: { always: true } },
  'you.wallet': { label: 'in your wallet', rule: { always: true } },
  'you.empty': { label: 'Nothing deposited yet', rule: { always: true } },
  'you.emptyHint': { label: 'Tap a cell and deposit to join the network.', rule: { always: true } },

  // activity
  'feed.deposit': { label: 'Deposit', rule: { always: true } },
  'feed.withdraw': { label: 'Withdrawal', rule: { always: true } },
  'feed.split': { label: 'Divided', rule: { always: true } },
  'feed.others': { label: 'Other players', rule: { deposits: 1 }, note: 'before a first deposit, only your own rows show' },
  'feed.empty': { label: 'Quiet for now', rule: { always: true } },

  // empty states
  'empty.noCell': { label: 'No cell selected', rule: { always: true } },
  'empty.noCellHint': { label: 'Tap a cell in the network to see it here.', rule: { always: true } },
} satisfies Record<string, Entry>

export type InfoId = keyof typeof INFO

let revealAll = typeof location !== 'undefined' && new URLSearchParams(location.search).get('reveal') === 'all'
export const setRevealAll = (v: boolean) => { revealAll = v }
export const isRevealAll = () => revealAll

function passes(rule: Rule, c: Ctx): boolean {
  if ('always' in rule) return true
  if ('never' in rule) return false
  if ('heldHere' in rule) return c.heldHere >= rule.heldHere
  if ('heldTotal' in rule) return c.heldTotal >= rule.heldTotal
  if ('deposits' in rule) return c.deposits >= rule.deposits
  if ('trait' in rule) return rule.trait === 'any' ? c.traits.length > 0 : c.traits.includes(rule.trait)
  if ('any' in rule) return rule.any.some(r => passes(r, c))
  if ('all' in rule) return rule.all.every(r => passes(r, c))
  return false
}

/** Is this piece of information visible to the player right now? */
export function shown(id: InfoId, c: Ctx): boolean {
  return revealAll || passes((INFO[id] as Entry).rule, c)
}

/** The words for this piece of information. */
export function t(id: InfoId): string {
  return INFO[id].label
}
