// First-time guide: a few glass cards over the live colony. Never blocks the field: the card
// floats at the top, and taps go through to the specimens. All cards sit in one grid cell so the
// card keeps the size of its longest page and never resizes between steps; pages cross-fade.
// Shown once per browser (localStorage), or on demand with ?guide in the URL.
import { useEffect } from 'react'
import { GUIDE, GUIDE_WORDS, type GuideCard } from './reveal'

const KEY = 'evolution.guide'

/** Show the guide at start? Yes on a first visit, or with ?guide in the URL. */
export function guideAtStart(): boolean {
  if (new URLSearchParams(location.search).has('guide')) return true
  try { return !localStorage.getItem(KEY) } catch { return true }
}

export function markGuideSeen() {
  try { localStorage.setItem(KEY, 'seen') } catch { /* private mode: shows again next time */ }
}

/** 1 ppm = 0.0001%: the fee rule as a short percentage. */
const pct = (ppm: number) => `${(ppm / 1e4).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}%`

export function Guide({ step, feePpm, catalyst, onStep, onClose, onDone, side, cards = GUIDE }: {
  step: number
  feePpm: number
  catalyst: string
  onStep: (n: number) => void
  onClose: () => void
  onDone: () => void // last card: close the guide and return to the living colony
  side: boolean // desktop side panel open: center over the colony, not the panel
  cards?: GuideCard[] // demo: the set without the fee card
}) {
  const last = step === cards.length - 1
  const fill = (s: string) => s.replace('{fee}', pct(feePpm)).replace('{catalyst}', catalyst)

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])

  return (
    <div className={`guide glass membrane ${side ? 'side-open' : ''}`} role="dialog" aria-label={GUIDE_WORDS.label} aria-live="polite">
      <div className="guide-pages">
        {cards.map((c, i) => (
          <div key={i} className={`guide-page ${i === step ? 'on' : ''}`} aria-hidden={i !== step}>
            <div className="guide-title">{c.title}</div>
            <div className="guide-body">{fill(c.body)}</div>
          </div>
        ))}
      </div>
      <div className="guide-foot">
        <span className="guide-dots" aria-hidden="true">
          {cards.map((_, i) => <span key={i} className={i === step ? 'on' : i < step ? 'past' : ''} />)}
        </span>
        {!last && <button className="guide-skip" onClick={onClose}>{GUIDE_WORDS.skip}</button>}
        <button className="guide-next cell-quiet" onClick={() => (last ? onDone() : onStep(step + 1))}>
          {last ? GUIDE_WORDS.done : GUIDE_WORDS.next}
        </button>
      </div>
    </div>
  )
}
