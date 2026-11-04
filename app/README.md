# App

Skeleton client: the glow field drawing the live network from the local chain, plus a basic deposit and withdraw panel. No wallet yet; "you" is a local test account.

From the repo root, in three terminals:

```
./local.sh                    # 1. local chain + contracts (demo odds by default; PRESET=real ./local.sh for real odds)
cd app && npm install && npm run abi && npm run dev     # 2. the app, at http://127.0.0.1:5173
cd app && npm run activity    # 3. gentle background deposits and withdrawals (PACE=fast for busier)
```

Run `npm run abi` again after every `./local.sh` restart; it copies the fresh addresses into the app.

- `src/field.ts`: the glow renderer (ported from the approved look test). Chain state drives it.
- `src/chain.ts`: reads nodes and events from the chain; sends your deposits and withdrawals.
- `src/App.tsx`: the field, the status line, and the node panel.
- `scripts/activity.mjs`: test accounts 1 to 8 acting at random. Stops withdrawing-only above 20 live nodes.

Keys: click a node to open it, H hides the interface, Esc deselects. Your deposits glow gold.
