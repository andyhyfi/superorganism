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

## Controls

Two modes over one field.

- **Aquarium:** full screen, no menus. The camera frames the whole network on its own. The status line fades after 4 still seconds and returns on any movement. If you move the camera, it eases back to the full view after 15 seconds idle.
- **Deep:** the menu layer. A side panel on desktop; a bottom sheet on phones (tap the grabber: half, full, peek). The camera centers in the space the panel leaves free and holds where you put it.

| Action | Mouse / keyboard | Touch |
|---|---|---|
| Open a node (enters Deep) | Click | Tap |
| Follow a node | Double-click, or Center in its panel, or C | Double-tap |
| Zoom | Scroll, trackpad pinch, + / − | Pinch, + / − buttons |
| Pan | Drag | Drag |
| Fit whole network | F, or ⤢ | Double-tap empty space, or ⤢ |
| Switch mode | Tab, or the Deep / Aquarium button | The Deep / Aquarium button |
| Deep tabs | 1 Node · 2 Network · 3 Yours · 4 Feed | Tap the tab |
| Back | Esc (deselect, then Aquarium) | × |
| Hide Aquarium status | H | |

Deep tabs:
- **Node:** holdings, generation, roll and split chance, split odds, fee, your claim, lineage back to the root, deposit and withdraw.
- **Network:** totals (live nodes, splits, USDC held, generations, fees owed) and every live node, sortable by size, age, or generation. A gold dot marks nodes where you hold a claim.
- **Yours:** every claim you hold, with one withdraw-all (batched 50 nodes per transaction when needed).
- **Feed:** live deposits, withdrawals, and splits. Tap any row to go to its node.

Look is placeholder (type, colour, material); structure and behaviour are real.
