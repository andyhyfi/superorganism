// The app's state machines, written down. Each is a pure reducer: one current state, a fixed set
// of events, and a rule for every pair. An event that does not fit the current state changes
// nothing (for example, a second "start" while a feed is in flight), so impossible states cannot
// happen. No React, no chain calls: `node --experimental-strip-types scripts/machines.test.ts`
// runs every transition. Map of all machines (explicit and local): app/STATE.md.

// ------------------------------------------------------------------ transaction (feed / draw)
export type TxKind = 'deposit' | 'withdraw' | 'withdrawAll' | 'game' // game: demo actions (mutations, sinks)
export type TxStage = 'approving' | 'sending' | 'confirming'
export type Tx = { phase: 'idle' } | { phase: TxStage; kind: TxKind }
export type TxEvent =
  | { type: 'start'; kind: TxKind }
  | { type: 'stage'; stage: TxStage }
  | { type: 'end' } // success or failure: the notice machine carries any message

export const txIdle: Tx = { phase: 'idle' }

export function tx(s: Tx, e: TxEvent): Tx {
  switch (e.type) {
    case 'start':
      return s.phase === 'idle' ? { phase: 'sending', kind: e.kind } : s // one transaction at a time
    case 'stage':
      return s.phase === 'idle' ? s : { phase: e.stage, kind: s.kind }
    case 'end':
      return txIdle
  }
}

/** The kind in flight, or null: what the buttons read (busy label, disabled). */
export const txBusy = (s: Tx): TxKind | null => (s.phase === 'idle' ? null : s.kind)

// ------------------------------------------------------------------ chain link (boot + polling)
export type Link =
  | { phase: 'connecting' }
  | { phase: 'live'; block: bigint }
  | { phase: 'lost'; misses: number; block: bigint } // polls failing; the last good block is kept
  | { phase: 'failed'; error: string } // boot failed: nothing to show until reload
export type LinkEvent =
  | { type: 'ok'; block: bigint }
  | { type: 'miss' }
  | { type: 'fail'; error: string }

export const linkStart: Link = { phase: 'connecting' }
/** Polls that may fail in a row before the player is told (one slow answer is not news). */
export const LOST_AFTER = 3

export function link(s: Link, e: LinkEvent): Link {
  if (s.phase === 'failed') return s // terminal until reload
  switch (e.type) {
    case 'ok':
      return { phase: 'live', block: e.block }
    case 'miss':
      if (s.phase === 'connecting') return s
      return { phase: 'lost', misses: (s.phase === 'lost' ? s.misses : 0) + 1, block: s.block }
    case 'fail':
      return { phase: 'failed', error: e.error }
  }
}

/** Lost long enough to tell the player. */
export const linkDown = (s: Link) => s.phase === 'lost' && s.misses >= LOST_AFTER

// ------------------------------------------------------------------ notice (the one toast)
// One slot. A new message replaces the old one and restarts its timer (each notice has its own
// id, so an old timer can never clear a newer message). A sticky notice stays until cleared.
export type Notice = { id: number; text: string; sticky: boolean } | null
export type NoticeEvent =
  | { type: 'show'; text: string; sticky?: boolean }
  | { type: 'expire'; id: number }
  | { type: 'clearSticky' }

export const NOTICE_MS = 5000

export function notice(s: Notice, e: NoticeEvent): Notice {
  switch (e.type) {
    case 'show':
      return { id: (s?.id ?? 0) + 1, text: e.text, sticky: !!e.sticky }
    case 'expire':
      return s && s.id === e.id && !s.sticky ? null : s
    case 'clearSticky':
      return s?.sticky ? null : s
  }
}
