// Starting values for the game rules. Every value may change between test eras.
// Hours are game hours; the server maps real time to game time.

export const VALUES = {
  // epochs and eras
  eraEpochs: 10,
  targetHours: Array.from({ length: 10 }, (_, i) => 24 * 7 ** (i / 9)), // 24 h -> 168 h, geometric
  failFactor: 2, // an epoch fails at 2x its target length

  // objectives
  objStart: 10, // specimens required at level 0
  objMin: 100, // dENERGY a specimen needs to count
  objGrowth: 2.123148853506306, // required specimens x per level
  holdStartH: 3, // hours objectives must hold at level 0
  holdAddH: 2, // extra hours per level
  windowH: 0.5, // challenge window, inside the hold
  traitShare: 0.692644516667645, // first mutation objective: share of required specimens
  traitGrowth: 1.2317907892349786, // share x per level (capped at 1)
  typesEvery: 2, // one more mutation type every N levels
  maxTypes: 4,
  mutStartEra1: 3, // era 1: mutation objectives from level 3 (epoch 4)
  mutStartLater: 1, // eras 2+: easiest objectives need no mutation (Andy 2026-11-10), mutations from level 1
  kStartEra1: 2, // era 1: every specimen >= K energy from epoch 3; later eras from epoch 1
  kMin: 1,
  kGrowth: 1.5,
  ease: true, // objectives shrink when active feeders fall below their peak (Andy 2026-11-10)
  easeFloor: 0.25, // never below 25% of the designed size (and never below objStart)

  // Bloom
  bloomCheckMin: 5, // a check every 5 minutes once objectives hold
  bloomCheckP: 0.1, // chance per check
  era1Bloom: 446793.52002858504, // era n makes n x this
  emitK: 1.8440237474742425, // epoch n gets n^k of the era total
  wTime: 1.1749735799426673, // split weight = average placed dENERGY x hours^wTime
  treasury0: 0.15,
  treasuryStep: 0.01,
  treasuryFloor: 0.01,
  burnGate: 3, // voluntary burn open while player BLOOM >= 3x the epoch's mutation need

  // mutations (BLOOM)
  activate: 28.309222290762143,
  express: 0.7424802401744927,
  expressGrowth: 1.5222244249309147, // per repeat, per player, per mutation, per epoch
  costRise: 0.013809532337927477, // per epoch after era 1 epoch 4
  show0: 0.1574801408866236, // first show chance; rises per miss
  showCeil: 0.5,

  // colony
  divCap: 0.5,
  divMid: 100,
  secondRollAt: 1000,
  loanChance: 0.15,
  loanMinH: 5 / 60,
  loanMaxH: 1,
  loanShareMin: 0.05,
  loanShareMax: 0.2,
  empty: 0.01, // at or below = empty

  // optional sinks (demo set, Andy 2026-11-10). Costs follow the mutation price scale.
  sinkOpen: { name: 1, color: 1, steer: 2 } as Record<string, number>, // era 1 epoch index they open (later eras: open)
  colors: 8, // palette size (app species file)
  recolorLockH: 1, // a specimen can be recolored once per hour
  nameRule: '^[A-Za-z0-9_-]{3,16}$', // string so the state stays plain JSON
  blockedNames: ['admin', 'evolution', 'official', 'moderator'], // placeholder list; demo server keeps the full one

  // dENERGY / eENERGY (demo)
  eRatePerYear: 0.1, // eENERGY per placed dENERGY per year; open, era mechanic later
  signup: 1000,
  referral: 500,
}

export type Values = typeof VALUES
