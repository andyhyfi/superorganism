# engine

Game rules as one pure TypeScript module. The game server owns one `State`, applies player actions with their time, and calls `tick()` on a timer. Same seed and same actions give the same game.

- `src/values.ts`: starting values. Every value may change between test eras.
- `src/engine.ts`: rules, actions (`join`, `feed`, `draw`, `drawAll`, `activate`, `express`, `burn`), `tick`, and `check` (conservation rules).
- `test/engine.test.ts`: rule tests, parity with the economy simulator, a 3-era bot game. `npm test`.

## Rules that protect balances

- A player's dENERGY = granted − placed, always. Placing and drawing only move dENERGY between a player's balance and their own placements.
- Loans, divisions and dissipation change specimen mass, never claims. A draw always returns the full placement, even from a drained or gone specimen.
- Every epoch, failed or not, ends with all placed dENERGY back in balances.
- BLOOM minted = player BLOOM + treasury. Player BLOOM held + burned = player BLOOM minted.
- `check(state)` throws if any of these break. Tests run it after every action.
