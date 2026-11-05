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
//   { deposited: n }                  player's USDC deposited minus withdrawn is at least n (fees not subtracted)
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
  | { deposited: number }
  | { trait: string }
  | { any: Rule[] }
  | { all: Rule[] }

export type Ctx = {
  heldHere: number // USDC the player holds in the cell being viewed
  heldTotal: number // USDC the player holds across the network
  deposits: number // deposits the player has made
  deposited: number // USDC the player deposited minus USDC withdrawn (before fees)
  traits: string[] // mutations on the cell being viewed
}

type Entry = { label: string; rule: Rule; note?: string }

/**
 * Network activity (Activity tab). Every value here is a setting, safe to change at any time.
 *   visible  master switch. false hides ALL network activity from everyone (launch plan, Andy
 *            2026-11-05); the Activity tab then disappears. Your own activity stays on Yours.
 *   levels   USDC a player must have deposited (deposits minus withdrawals, before fees) to see
 *            each kind of other players' activity. 0 = everyone; Infinity = no one.
 *            Withdrawing below a level hides that kind again.
 * This is game design, not privacy: every event is public on the chain for anyone who reads it.
 */
export const NETWORK_ACTIVITY = {
  visible: true, // set false for launch (Andy, 2026-11-05)
  levels: {
    deposits: 100,
    withdrawals: 500,
    loans: 1000, // loans and energy returns
    splits: 100, // also visible in the field, so kept with deposits
  },
}

function networkRule(kind: keyof typeof NETWORK_ACTIVITY.levels): Rule {
  if (!NETWORK_ACTIVITY.visible) return { never: true }
  const n = NETWORK_ACTIVITY.levels[kind]
  return Number.isFinite(n) ? { deposited: n } : { never: true }
}

/** True when the Activity tab has anything it could ever show (false at launch). */
export const networkActivityExists = () =>
  NETWORK_ACTIVITY.visible && Object.values(NETWORK_ACTIVITY.levels).some(n => Number.isFinite(n))

export const INFO = {
  // tabs
  'tab.node': { label: 'Specimen', rule: { always: true } },
  'tab.network': { label: 'Colony', rule: { always: true } },
  'tab.yours': { label: 'Tended', rule: { always: true } },
  'tab.activity': { label: 'Signals', rule: { always: true } },

  // a cell
  'cell.observe': { label: 'Focus', rule: { always: true } },
  'cell.deposits': { label: 'Fed', rule: { always: true }, note: 'money rule: keep visible' },
  'cell.loans': { label: 'Mass on loan', rule: { always: true } },
  'cell.lentTo': { label: 'Lent to', rule: { always: true } },
  'cell.borrowedFrom': { label: 'Borrowed from', rule: { always: true } },
  'cell.returnsIn': { label: 'Returns in', rule: { always: true } },
  'cell.maximum': { label: 'Max', rule: { always: true }, note: 'money rule: keep visible' },
  'cell.eventFee': { label: 'Catalyst', rule: { always: true }, note: 'money rule: keep visible' },
  'cell.eventFeeHint': { label: 'Fee when a feed sets off a catalyst', rule: { always: true } },
  'cell.divideChance': { label: 'Division chance', rule: { heldHere: 10 }, note: 'placeholder gate' },
  'cell.fillCheck': { label: 'Fullness', rule: { heldHere: 100 }, note: 'placeholder gate' },
  'cell.divideOdds': { label: 'Then divides', rule: { heldHere: 100 }, note: 'placeholder gate' },
  'cell.generation': { label: 'Strain', rule: { deposits: 3 }, note: 'placeholder gate' },
  'cell.fee': { label: 'Fee', rule: { always: true }, note: 'money rule: keep visible' },
  'cell.minimum': { label: 'Min', rule: { always: true }, note: 'money rule: keep visible' },
  'cell.lineage': { label: 'Lineage', rule: { heldTotal: 50 }, note: 'placeholder gate' },
  'cell.traits': { label: 'Mutations', rule: { trait: 'any' }, note: 'appears once mutations exist' },

  // actions (money in and out is never hidden)
  'act.amount': { label: 'Amount', rule: { always: true } },
  'act.deposit': { label: 'Feed', rule: { always: true } },
  'act.depositing': { label: 'Feeding…', rule: { always: true } },
  'act.withdraw': { label: 'Draw', rule: { always: true } },
  'act.withdrawing': { label: 'Drawing…', rule: { always: true } },
  'act.withdrawAll': { label: 'Draw all', rule: { always: true } },
  'act.max': { label: 'Max', rule: { always: true } },
  'act.belowMin': { label: 'Min is 1', rule: { always: true } },
  'act.overWallet': { label: 'More than your wallet holds', rule: { always: true } },
  'act.overClaim': { label: 'More than you can draw', rule: { always: true } },
  'act.clear': { label: 'Clear', rule: { always: true } },
  'act.overDeposit': { label: 'Over the 1,000 limit per feed', rule: { always: true } },
  'act.overUser': { label: 'Over your 1,000 total limit', rule: { always: true } },
  'act.nothingHere': { label: 'Nothing to draw here', rule: { always: true } },
  'you.cell': { label: 'Specimen', rule: { always: true } },
  'hud.wallet': { label: 'Wallet', rule: { always: true } },
  'hud.deposited': { label: 'Fed', rule: { always: true } },
  'hud.myCells': { label: 'Tended', rule: { always: true } },

  // the network
  'net.counts': { label: 'specimens', rule: { always: true } },
  'net.splits': { label: 'divisions', rule: { deposits: 1 } },
  'net.generations': { label: 'strain', rule: { heldTotal: 50 } },
  'net.list': { label: 'All specimens', rule: { always: true } },
  'net.sort': { label: 'Sort', rule: { deposits: 1 } },
  'net.fees': { label: 'Fees collected', rule: { heldTotal: 500 }, note: 'placeholder gate' },

  // the player

  // activity
  'feed.deposit': { label: 'Feed', rule: { always: true } },
  'feed.withdraw': { label: 'Draw', rule: { always: true } },
  'feed.split': { label: 'Division', rule: { always: true } },
  'feed.loan': { label: 'Mass lent', rule: { always: true } },
  'feed.repay': { label: 'Mass returned', rule: { always: true } },

  // Activity tab: what other players do. Each kind unlocks at its own level (USDC deposited). Levels and the master switch live in NETWORK_ACTIVITY below.
  'net.seeDeposits': { label: 'Colony feeds', rule: networkRule('deposits') },
  'net.seeWithdrawals': { label: 'Colony draws', rule: networkRule('withdrawals') },
  'net.seeSplits': { label: 'Colony divisions', rule: networkRule('splits') },
  'net.seeLoans': { label: 'Colony mass loans', rule: networkRule('loans') },

  // Yours tab: your own history
  // sorting the colony list
  'sort.mass': { label: 'Mass', rule: { always: true } },
  'sort.youngest': { label: 'Youngest', rule: { always: true } },
  'sort.eldest': { label: 'Eldest', rule: { always: true } },

  // the bottom mode button: Observe = the living field only; Study = open the menu
  'mode.observe': { label: 'Observe', rule: { always: true } },
  'mode.study': { label: 'Study', rule: { always: true } },

  'you.activity': { label: 'Your signals', rule: { always: true } },

  // empty states
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
  if ('deposited' in rule) return c.deposited >= rule.deposited
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
