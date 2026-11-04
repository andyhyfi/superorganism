# Security review: Evolution v0

Scope: `src/Evolution.sol` at the commit that last changed this file. Testnet only. This is an internal review, not an audit.

## Automated

- Slither 0.11.6, 102 detectors, `lib/` and `test/` excluded: 0 findings.
- Fixed earlier: `withdrawAll` wrote `feesAccrued` to storage once per node inside its loop (`costly-loop`). Fees now add up in memory and are written once.
- Fixed with the two-layer roll: the curve's scale factor divided before multiplying (`divide-before-multiply`); it is now an exact constant.
- Suppressed with a reason in code: Slither `incorrect-equality` on the 1-in-`splitOdds` draw (an exact match is intended); forge `reentrancy-events` on `Split` and `SplitRolled` (both are emitted before the only external call).
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

Known limits, open before real funds:

1. **Placeholder randomness.** Both roll layers use block data. A depositor can simulate the result, or call from a contract and cancel unwanted results, so splits can be forced or avoided. Replace before mainnet.
2. **Forced fragmentation.** Anyone can deposit into a live node and roll for a split. Splits never move value between users, and each split rounds every claim down by at most about 2 × `splitUnit` (0.00002 USDC). With the two-layer roll a 1 USDC deposit into a 100 USDC node splits it about once in 2,000 tries, and every try costs at least 1 USDC of locked deposit plus gas. Only limit 1 makes forcing cheap. The rounding loss becomes unowned fill and reaches the treasury. Network-size mechanics bound it further.
3. **Fee rounding.** At 1 ppm (0.0001%), the fee on 1 USDC is exactly 1 base unit. With the 1 USDC minimums, every deposit and every withdrawal of at least 1 USDC pays a fee. A whole-claim withdrawal under 1 USDC, allowed so halved claims can leave, pays 0.
4. **USDC controls.** Circle can blacklist addresses or pause USDC. A blacklisted treasury blocks `sweepFees()` but not user withdrawals. A blacklisted contract address freezes everything. This is inherent to USDC.
5. **Split race.** A node can split between a user's check and their transaction. `withdraw` then reverts with `NodeNotLive`, and `withdrawAll` skips the node. The client must refresh and retry against the children. A full sweep across more than 50 nodes needs several `withdrawAll` calls; the client can batch them.
6. **Token assumptions.** The accounting assumes a token without transfer fees or rebasing, which USDC meets. Do not deploy against other tokens without review.

## Before mainnet

- Replace the randomness (limit 1).
- Set the network-size mechanics (limit 2).
- Get an external audit.
