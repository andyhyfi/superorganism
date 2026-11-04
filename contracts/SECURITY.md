# Security review: Evolution v0

Scope: `src/Evolution.sol` at the commit that adds this file. Testnet only. This is an internal review, not an audit.

## Automated

- Slither 0.11.6, 102 detectors, `lib/` and `test/` excluded: 0 findings.
- One earlier finding, fixed: `withdrawAll` wrote `feesAccrued` to storage once per node inside its loop (`costly-loop`). Fees now add up in memory and are written once.
- Forge lint: 4 warnings, all reviewed and expected. Three flag error checks inside loops (batch guards). One flags the placeholder randomness.

## Manual review

Checked and holding:

- **Reentrancy.** Every external function that moves tokens is `nonReentrant`, updates state before the transfer, and uses OpenZeppelin `SafeERC20`.
- **Solvency.** Node totals cover every claim, and the balance equals fees owed plus live node totals. Both are proven by the invariant suite.
- **Rounding.** Rounding is always down, and rounding each part never yields more than rounding the whole. Proven by fuzz tests.
- **Access.** No owner, admin, upgrade path, or pause. The treasury address is fixed at deployment. `sweepFees()` can only pay the treasury.
- **Gas bounds.** No state change loops over depositors. `withdrawAll` is capped at 50 nodes, and the claim walk at 128 generations.
- **Overflow.** Solidity 0.8 checked math, plus `SafeCast` on every narrowing conversion.

Known limits, open before real funds:

1. **Placeholder randomness.** The split roll uses block data. A depositor can simulate the result, or call from a contract and cancel unwanted results, so splits can be forced or avoided. Replace before mainnet.
2. **Forced fragmentation.** Anyone can deposit the minimum into any live node to roll for a split, so a node holding other users' funds can be pushed to split. Splits never move value between users. But each halving rounds every claim down by up to about 2 × `splitUnit`, so a claim spread over a deep tree loses up to roughly 2^(depth+1) × `splitUnit` in total. At about 20 nodes that is under 0.0004 USDC. The rounding loss becomes unowned fill and eventually reaches the treasury. Network-size mechanics and a meaningful `minDeposit` bound this.
3. **Fee rounding.** At 1 ppm (0.0001%), any deposit or withdrawal under 1 USDC pays a fee of 0.
4. **USDC controls.** Circle can blacklist addresses or pause USDC. A blacklisted treasury blocks `sweepFees()` but not user withdrawals. A blacklisted contract address freezes everything. This is inherent to USDC.
5. **Split race.** A node can split between a user's check and their transaction. `withdraw` then reverts with `NodeNotLive`, and `withdrawAll` skips the node. The client must refresh and retry against the children.
6. **Token assumptions.** The accounting assumes a token without transfer fees or rebasing, which USDC meets. Do not deploy against other tokens without review.

## Before mainnet

- Replace the randomness (limit 1).
- Set `minDeposit` and the network-size mechanics (limit 2).
- Get an external audit.
