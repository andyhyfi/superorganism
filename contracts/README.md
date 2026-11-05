# Contracts

Foundry project.

```
forge build
forge test                      # unit, fuzz (1,000 runs each), invariant (256 runs x 64 calls)
FOUNDRY_PROFILE=deep forge test # invariant runs of 500 calls, for deep split trees
slither .
```

## Tests

- `test/Evolution.t.sol`: unit tests for every function and error path, the split curve's target points and shape, and statistical checks of the real two-layer roll.
- `test/Evolution.fuzz.t.sol`: property tests over random amounts, fees, and rounding units. Rounding each part never yields more than rounding the whole; lazy claims equal repeated halving; the roll chance never falls as fill grows and never passes the cap.
- `test/invariant/`: random sequences of deposits, splits, withdrawals, batch withdrawals, and fee sweeps across five users. After every step:
  - the token balance equals fees owed plus every live node's total;
  - no node owes more than it holds;
  - the contract can pay everything it owes;
  - no user gets out more than they put in;
  - every child points at its parent, sits one level deeper, and copies its traits.
  After each run every user withdraws everything; what remains must equal the unowned fill and stay under its rounding bound.
- `test/Evolution.loans.t.sol`: energy loans, loan events, deposit limits. A differential fuzz test proves loans never change what withdrawals pay.
- The invariant suite also runs loan events and lets time pass. After every step, energy lent out equals energy borrowed, and the live-node list matches the tree.
- `test/utils/EvolutionHarness.sol`: test-only subclass that can force the split roll and the event roll.
- `src/mocks/EvolutionDemo.sol`: LOCAL CHAIN ONLY. Evolution plus two test dials (split chance, event chance) that anyone can set; it refuses any chain but 31337. The production contract has no dials.

## Split and remainder logic

`src/Evolution.sol` grows a network of nodes from one root.

### Splits

Every deposit into a live node can split it. The roll has two layers, drawn separately:

1. **Roll chance.** The node's fill (its token total after the deposit) sets the chance that the deposit gets to roll at all, on an S-curve:

   `chance = cap × r² / (r² + 1)`, where `r = fill / rollMidFill`

   The square keeps small nodes near zero, the curve rises fastest around the midpoint, and it flattens toward the cap without ever reaching it. Deployed traits: cap 10% (`rollCapPpm = 100_000`, the hard maximum in code), midpoint 300 USDC.

   | Node fill | Roll chance | Split chance (both layers) |
   |---|---|---|
   | 1 USDC | 0.0001% | 0.000006% |
   | 10 USDC | 0.011% | 0.0006% |
   | 50 USDC | 0.27% | 0.014% |
   | 100 USDC | 1% | 0.05% |
   | 300 USDC | 5% | 0.25% |
   | 1,000 USDC | 9.2% | 0.46% |
   | 5,000 USDC | 9.96% | 0.50% |

2. **Split roll.** A deposit that wins layer one rolls a fixed 1-in-`splitOdds` (20) for the split. The odds are set at deployment and never change, so a winning roll can still not split.

- `rollChance()` and `splitChance()` return both numbers for the UI. `SplitRolled` is emitted whenever layer two is rolled.
- A split divides the node into two identical children. Each child gets half the parent's total, and every user's claim halves into each child.
- A split node takes no more deposits or withdrawals. Its claims live in the children.
- Accounting is lazy, so a split never loops over depositors. A user's position is recorded only at nodes the user touched. A claim on any other node is read from the nearest ancestor the user touched, halved once per generation between them.

### Minimums

- `minDeposit` and `minWithdraw` are set at deployment: 1 USDC each.
- A withdrawal below `minWithdraw` is allowed only when it takes the user's whole claim on that node, so halved claims under 1 USDC can always leave. `withdrawAll` always takes whole claims.

### Rounding and remainders

Halves round down to a multiple of `splitUnit`, set at deployment. For USDC (6 decimals), `splitUnit = 10` rounds to five decimals (0.00001 USDC).

1. **Child totals.** Each child's total is half the parent's total, rounded down.
2. **Node remainder.** The difference between the parent's total and the two children's totals goes to the treasury. It joins the fees and leaves with the next `sweepFees()` call. It is at most `2 * splitUnit - 1` base units per split.
3. **User claims.** Each user's claim on a child is half their parent claim, rounded down the same way. Rounding down each part never produces more than rounding down the whole, so a node's total is always at least the sum of its users' claims. Rounding never creates value, and the contract always holds what users are owed.
4. **Unowned fill.** Per-user rounding can leave a few base units in a node that belong to no user. They stay in the node, count toward its fill, and halve with it at every later split. Their share of each split's remainder goes to the treasury under rule 2. Paying them out at split time would need a loop over every depositor, which the contract never does.

### Fees

- A per-node fee (parts per million, capped at 1%) applies to deposits and withdrawals.
- Fees and split remainders accrue in `feesAccrued`. Anyone can call `sweepFees()`, and it always pays the fixed treasury address.

### Energy loans

Users see a cell's size as energy. Money stays in exact USDC.

- **Claims never move.** A user's claim changes only through their own deposit or withdrawal, or a split that halves it into both children. Loans move no tokens and change no claim.
- **Events.** A deposit has a chance, per cell, to start a loan event (default 15%, hard cap 50%). The depositor pays `eventFee` on top of the deposit; it goes to the treasury to pay for the random number. One request can be open at a time; an unanswered request expires after 10 minutes, so deposits and withdrawals never wait on it.
- **Sends.** Only the fixed `operator` (Gelato VRF on Ink) can run an event, with its random number. An event makes up to 5 sends, each from a random live cell (the lender) to a different random live cell (the borrower). A send that cannot happen is skipped; the event never reverts on cell state. Each send rolls the borrower for a split.
- **Loan size and time.** 5% to 20% of the lender's own energy not already lent. Due at a random time between `loanMinSecs` and `loanMaxSecs` (default 5 to 60 minutes; hard limits 1 minute and 1 day).
- **Caps.** A cell lends at most `loansOutCap` loans at once (default 1, hard cap 4) and holds at most 4 loan parts.
- **Roll fill.** The split roll uses: own energy not lent out, plus borrowed energy up to that same amount. Borrowed energy is therefore at most 50% of the roll fill.
- **Return.** A loan ends at its due time with no transaction. It also ends early when any user withdraws from the lender (a withdrawal repays every loan out of that cell; the repay only sets flags and cannot fail), or when the lender splits.
- **Borrower splits.** Each child gets half of each loan part it held; the first child gets the odd base unit, so parts still sum to the loan.
- **Limits.** `maxDeposit` per deposit and `maxPerUser` per user in total (net of fees), both 1,000 USDC at deployment.

### What it does not have

- No owner, admin key, or upgrade path. Rules change only by deploying a new contract.
- No mutations yet. Per-cell traits and loan rules are stored per cell and children copy them. What mutations do is not decided; they get tested after the core mechanics are built and well tested. Node traits (fee, fill measure, roll-chance cap and midpoint) are stored per node from day one, and children copy them.
- The split roll and the event roll inside a deposit use block data as a placeholder. A depositor can predict it and cancel unwanted results. It must be replaced before real funds.

## Local test chain

From the repo root:

```
./local.sh
```

Starts a private chain on this Mac (chain ID 31337, `http://127.0.0.1:8545`, 1-second blocks), deploys mock USDC and Evolution with the default rules, gives ten test accounts 100,000 mock USDC each, and seeds the root node with 125 USDC from three accounts. Addresses go to `contracts/deployments/local.json`. Ctrl+C stops it; every restart begins from an empty chain. The test accounts come from anvil's public test mnemonic and only ever hold mock tokens.
