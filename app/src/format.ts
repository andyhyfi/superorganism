import { usd } from './chain'

export const fmtUsd = (x: bigint | number) => {
  const v = typeof x === 'bigint' ? usd(x) : x
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** A 1e18-scaled probability as a percentage with sensible precision. */
export const fmtPct = (wad: bigint) => {
  const v = Number(wad) / 1e16
  if (v === 0) return '0%'
  return v >= 1 ? `${v.toFixed(2)}%` : v >= 0.01 ? `${v.toFixed(3)}%` : `${v.toFixed(5)}%`
}

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

export const ago = (ms: number) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`
}
