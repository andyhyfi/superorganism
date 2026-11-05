// A number that rolls to its new value instead of jumping: fast at first, easing into place.
// Digits are tabular, so the width stays steady while it rolls.
import { useEffect, useRef, useState } from 'react'
import { fmtUsd } from './format'

const ROLL_MS = 900 // how long a change takes to roll in

export function Rolling({ value }: { value: bigint }) {
  const target = Number(value) / 1e6
  const [shown, setShown] = useState(target)
  const from = useRef(target)
  const now = useRef(target)
  useEffect(() => {
    if (Math.abs(target - now.current) < 0.005) { now.current = target; setShown(target); return }
    from.current = now.current
    const start = performance.now()
    let raf = 0
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / ROLL_MS)
      const e = 1 - Math.pow(1 - p, 3) // ease out
      now.current = from.current + (target - from.current) * e
      setShown(now.current)
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target])
  return <>{fmtUsd(shown)}</>
}
