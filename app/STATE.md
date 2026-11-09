# App state machines

Every piece of state that moves through stages, where it lives, and how to read it. Pure machines are in `src/machines.ts` and tested by `npm run test:machines` (every transition). The current state of each machine is mirrored on the root element as `data-*` attributes, so tests, agents and devtools read it without React internals:

```js
document.querySelector('.stage').dataset
// { mode: 'deep', tab: 'node', sheet: 'half', selected: '3', tx: 'deposit:confirming',
//   link: 'live', guide: '2', sound: 'off' }
```

## Explicit machines (src/machines.ts, reducers)

| Machine | States | Events | Rule that matters |
|---|---|---|---|
| Transaction | idle, sending, approving, confirming (each with kind deposit / withdraw / withdrawAll) | start, stage, end | One transaction at a time: a second start while busy is ignored (no double feed or draw). The button shows Feeding… / Drawing… from this. |
| Chain link | connecting, live(block), lost(misses, block), failed(error) | ok, miss, fail | Polling errors are counted; after 3 misses in a row the player sees "Connection lost. Reconnecting…", which clears itself on the next good poll. A boot failure stays on screen. |
| Notice | none, or one message (id, text, sticky) | show, expire(id), clearSticky | One toast slot. Each message has an id, so an old timer can never clear a newer message (the earlier code could). |

## Machines kept as single values in React (App.tsx)

| Machine | States | Notes |
|---|---|---|
| View mode | aquarium, deep | Tab toggles; Esc deselects first, then returns to aquarium; tap on open water closes. |
| Tab | node, network, yours, feed | Keys 1-4 in deep mode. |
| Sheet (phones) | peek, half, full | Grabber drag snaps (sheetDrag.ts); tap steps through. |
| Selection | none, or a node id | A split hands the selection to the first child; a gone node with no claim clears it. |
| Guide | closed, or card 0-4 | One value (`guideStep: number | null`); before this change it was two values (showing + step). Card "tap" advances on a specimen tap; "feed"/"fee" open a menu. Seen once per browser (localStorage `evolution.guide`). |
| Overlay | shown, idle-hidden, hidden by H | Aquarium only; fades after 4 s still. |

## Machines in other modules

| Machine | Where | States |
|---|---|---|
| Camera | field.ts `camMode` | auto (frames the colony), manual (user moved it; eases back after 15 s in aquarium), follow (one node). Read with `__field.cameraMode()` in dev. |
| Sound engine | sound.ts | user choice on/off (the only state the button shows) x engine running/suspended; serialized resume/suspend (`busy` + `again`) so the last request wins; gesture-armed when the browser blocks audio. |
| Sheet drag | sheetDrag.ts | idle, pressed, dragging (moved > 4 px), then snap. |
| Gestures | gestures.ts | idle, down, pan, pinch; tap vs double tap by time and distance. |
| Node visual life | field.ts VNode | pending child, live, splitting (progress p), empty (dim, drifting to the ring), fading (dissipated), removed. |
| Node chain status | chain.ts ChainNode | live, split (divided), gone (dissipated; leftover claims stay drawable). |
| Approval | chain.ts `approved` | unknown, approved (cached for the session after the first check). |
| Amount entry | Tabs.tsx | empty, valid, below minimum, over limit (message replaces the button label; the menu never resizes); side deposit/withdraw. |
| Lineage map | Tabs.tsx `mapOpen` | closed, open. |
| Test dials | TestDials.tsx | closed, open (draft). Local chain only. |

## Adding a machine

1. If it has more than two states, or async steps, write it as a reducer in `machines.ts`: a state type, an event type, and one switch. Ignore events that do not fit the state.
2. Add its transitions to `scripts/machines.test.ts`.
3. Mirror its state on `.stage` as a `data-*` attribute.
4. Add a row here.
