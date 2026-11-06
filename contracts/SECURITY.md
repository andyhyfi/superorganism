# Security review: Evolution v2 (energy loans, dissipation)

Scope: `src/Evolution.sol` at the commit that last changed this file. Testnet only. This is an internal review, not an audit.

## Automated

- Slither 0.11.6, `lib/` and `test/` excluded: 0 findings, with `costly-loop` excluded (every loop is bounded: 5 sends per event, 50 nodes per withdrawAll, 4 loans out and 4 loan parts per node). `timestamp` is suppressed on the two lines that compare loan due times and the request timeout; a sequencer can shift a timestamp by seconds, which only moves energy.
- Fixed earlier: `withdrawAll` wrote `feesAccrued` to storage once per node inside its loop (`costly-loop`). Fees now add up in memory and are written once.
- Fixed with the two-layer roll: the curve's scale factor divided before multiplying (`divide-before-multiply`); it is now an exact constant.
- Suppressed with a reason in code: Slither `incorrect-equality` on the 1-in-`splitOdds` draw, the claim walk's root check, and the empty-fill check (each an intended exact match); forge `reentrancy-events` on `Split` and `SplitRolled` (both are emitted before the only external call).
- Forge lint: 4 warnings remain, all reviewed and expected. Three flag error checks inside loops (batch guards). One flags the placeholder randomness.

## Manual review

Checked and holding:

- **Reentrancy.** Every external function that moves tokens is `nonReentrant`, updates state before the transfer, and uses OpenZeppelin `SafeERC20`.
- **Solvency.** Node totals cover every claim, and the balance equals fees owed plus live node totals. Both are proven by the invariant suite.
- **Rounding.** Rounding is always down, and rounding each part never yields more than rounding the whole. Proven by fuzz tests.
- **Access.** No owner, admin, upgrade path, or pause. The treasury address, minimums, rounding unit, and split odds are fixed at deployment. `sweepFees()` can only pay the treasury.
- **Gas bounds.** No state change loops over depositors. `withdrawAll` is capped at 50 nodes, and the claim walk at 128 generations.
- **Overflow.** Solidity 0.8 checked math, `SafeCast` on every narrowing conversion, and OpenZeppelin `Math.mulDiv` in the curve. The curve's ratio is capped so its square cannot overflow at any `uint128` fill.
- **Curve bounds.** The roll chance never falls as fill grows and never passes the cap (fuzzed over the full `uint128` range). The cap itself is limited to 10% in code.

- **Loans cannot touch money.** `_take`, `_claim`, `withdraw` and `withdrawAll` pay from claims only. The loan repay inside a withdrawal writes flags only, with no check that can fail and no external call. A differential fuzz test proves withdrawals pay the same with and without loan events.
- **Loan balance.** Energy lent out of live cells always equals energy borrowed by live cells (invariant).
- **Dissipation cannot take money.** `dissipate` moves no tokens and changes no claim. It needs the node to hold under 0.01 USDC, have no active loan, and be quiet 5 minutes, and it never removes the last live node. A gone node only stops new deposits and loans; `withdraw` and `withdrawAll` still pay any leftover claim in it (unit test). Anyone can call it, so no keeper is trusted: the invariant suite calls it at random and checks it succeeds exactly when `canDissipate` says so.
- **Operator.** Only the fixed operator address can run a loan event. It can choose randomness, so it can steer energy and split rolls, never claims.

Known limits, open before real funds:

1. **Placeholder randomness.** Both roll layers use block data. A depositor can simulate the result, or call from a contract and cancel unwanted results, so splits can be forced or avoided. Replace before mainnet.
2. **Forced fragmentation.** Anyone can deposit into a live node and roll for a split. Splits never move value between users, and each split rounds every claim down by at most about 2 × `splitUnit` (0.00002 USDC). With the two-layer roll a 1 USDC deposit into a 100 USDC node splits it about once in 2,000 tries, and every try costs at least 1 USDC of locked deposit plus gas. Only limit 1 makes forcing cheap. The rounding loss becomes unowned fill and reaches the treasury. Network-size mechanics bound it further.
3. **Fee rounding.** At 1 ppm (0.0001%), the fee on 1 USDC is exactly 1 base unit. With the 1 USDC minimums, every deposit and every withdrawal of at least 1 USDC pays a fee. A whole-claim withdrawal under 1 USDC, allowed so halved claims can leave, pays 0.
4. **USDC controls.** Circle can blacklist addresses or pause USDC. A blacklisted treasury blocks `sweepFees()` but not user withdrawals. A blacklisted contract address freezes everything. This is inherent to USDC.
5. **Split race.** A node can split between a user's check and their transaction. `withdraw` then reverts with `NodeNotLive`, and `withdrawAll` skips the node. The client must refresh and retry against the children. A full sweep across more than 50 nodes needs several `withdrawAll` calls; the client can batch them.
6. **Token assumptions.** The accounting assumes a token without transfer fees or rebasing, which USDC meets. Do not deploy against other tokens without review.

7. **Operator liveness.** If the operator stops answering, loan events stop. Requests expire after 10 minutes; deposits and withdrawals are unaffected.
8. **Gas per withdrawal.** Each node in a withdrawal repays at most `loansOutCap` loans (hard cap 4).
9. **Event fee.** Set at deployment. The real Gelato VRF price on Ink is not confirmed; 0.01 USDC is a local placeholder.
10. **Dissipation griefing.** A 1 USDC deposit into an empty node restarts its 5-minute clock, so anyone can keep an empty node alive by paying deposits. This costs the griefer money and harms nobody's funds.

## Planned change: epochs (decided 2026-11-06, not built)

The current contract (v2) has no owner, admin, upgrade path or pause. The epoch design changes this rule to **no admin over money**:
- One permanent **vault** holds all USDC. It has no owner, no admin, no upgrade and no pause. Withdrawal, ownership of claims and the fee cap live only in the vault and can never change.
- A separate **rules** contract holds game rules only (objectives, Bloom chance, BLOOM amounts, mutations). Between epochs, a rules key can point the vault at a new rules contract. New rules are published at least 24 hours before the epoch starts.
- Rules key holder: mainnet = 2-of-3 Safe multisig; testnet = a single key. The 24-hour delay is enforced by the contract, not by the key holder.
- One exception: the rules key may raise the vault's per-player deposit maximum (starts at 1,000 USDC). Raise only, at most 10x per raise, effective 24 hours after it is announced. It can never lower it, so it can never trap funds.
- The rules key can never move USDC, change claims, block withdrawals or raise fees above the vault's cap. Tests must prove this for any rules contract, including a hostile one.

## Before mainnet

- Replace the randomness (limit 1).
- Set the network-size mechanics (limit 2).
- Get an external audit.
