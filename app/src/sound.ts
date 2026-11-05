// Sound: a gentle underwater ambience plus soft effects for network events.
// Everything is synthesized with Web Audio (no sound files, nothing to license or download).
// Off until the user turns it on (browsers allow audio only after a tap). The choice is saved.
// Tuning: the SOUND block below.

const SOUND = {
  master: 0.275, // overall volume: halved from 0.55 by default (Andy)
  ambience: 0.0198, // the bed under everything (hum, pads, water): two 70% cuts from the first 0.22 (Andy)
  water: 0.035, // the water noise inside the bed: kept very low and dark, so it never sounds like static
  effects: 0.34, // events: cut 15%, then 20%, from the first 0.5 (Andy)
  maxPerSecond: 4, // more events than this in a second are skipped (busy networks stay calm)
  reverb: 0.45, // how much of each effect goes to the water-like reverb
}

// A major pentatonic scale over two octaves: any two notes sound good together.
const SCALE = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21]
const BASE_HZ = 220 // A3

export type SoundKind = 'deposit' | 'withdraw' | 'split' | 'loan' | 'repay'

const KEY = 'evolution.sound'

class Sound {
  ctx: AudioContext | null = null
  out: GainNode | null = null
  private fx: GainNode | null = null
  recent: number[] = []
  on = false

  constructor() {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => this.applyVolume())
    }
  }

  /** The saved choice. The first tap after load starts audio if it was on. */
  get saved() {
    try { return localStorage.getItem(KEY) === 'on' } catch { return false }
  }

  setOn(on: boolean) {
    this.on = on
    try { localStorage.setItem(KEY, on ? 'on' : 'off') } catch { /* private mode */ }
    if (on) this.start()
    this.applyVolume()
  }

  private start() {
    if (this.ctx) { void this.ctx.resume(); return }
    const ctx = new AudioContext()
    this.ctx = ctx
    const out = ctx.createGain()
    out.gain.value = 0
    // a soft limiter so stacked effects never clip
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -18; comp.ratio.value = 4; comp.attack.value = 0.01; comp.release.value = 0.3
    out.connect(comp).connect(ctx.destination)
    this.out = out

    const verb = ctx.createConvolver()
    verb.buffer = impulse(ctx, 3.2)
    const wet = ctx.createGain()
    wet.gain.value = SOUND.reverb
    wet.connect(verb).connect(out)

    const fx = ctx.createGain()
    fx.gain.value = SOUND.effects
    fx.connect(out)
    fx.connect(wet)
    this.fx = fx

    this.ambience(ctx, out, wet)
  }

  private suspendTimer = 0

  private applyVolume() {
    const ctx = this.ctx
    if (!ctx || !this.out) return
    const audible = this.on && document.visibilityState === 'visible'
    window.clearTimeout(this.suspendTimer)
    if (audible && ctx.state === 'suspended') void ctx.resume()
    const t = ctx.currentTime
    this.out.gain.cancelScheduledValues(t)
    this.out.gain.setTargetAtTime(audible ? SOUND.master : 0, t, audible ? 0.8 : 0.15)
    // off: after the short fade, stop the audio engine completely (silent, no CPU)
    if (!audible) this.suspendTimer = window.setTimeout(() => { if (!this.on || document.visibilityState !== 'visible') void ctx.suspend() }, 900)
  }

  /** Stops and releases the audio engine (used when the code reloads during development). */
  close() {
    window.clearTimeout(this.suspendTimer)
    void this.ctx?.close()
    this.ctx = null
    this.out = null
    this.fx = null
  }

  /** The bed: two slow detuned pads, a deep hum, and filtered noise like moving water. */
  private ambience(ctx: AudioContext, out: GainNode, wet: GainNode) {
    const bed = ctx.createGain()
    bed.gain.value = SOUND.ambience
    bed.connect(out)
    bed.connect(wet)

    const pad = (hz: number, detune: number, level: number) => {
      const o = ctx.createOscillator()
      o.type = 'sine'; o.frequency.value = hz; o.detune.value = detune
      const g = ctx.createGain(); g.gain.value = level
      // each voice swells in and out over tens of seconds
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.02 + Math.random() * 0.03
      const depth = ctx.createGain(); depth.gain.value = level * 0.6
      lfo.connect(depth).connect(g.gain)
      o.connect(g).connect(bed)
      o.start(); lfo.start()
    }
    pad(55, 0, 0.35) // A1 hum
    pad(110, -6, 0.18)
    pad(164.8, 5, 0.1) // E3
    pad(220, -3, 0.05)

    // water: pink-ish noise through a slowly moving low-pass
    const noise = ctx.createBufferSource()
    noise.buffer = noiseBuffer(ctx, 4)
    noise.loop = true
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'; lp.frequency.value = 260; lp.Q.value = 0.3
    const sweep = ctx.createOscillator(); sweep.frequency.value = 0.035
    const sweepDepth = ctx.createGain(); sweepDepth.gain.value = 110
    sweep.connect(sweepDepth).connect(lp.frequency)
    const ng = ctx.createGain(); ng.gain.value = SOUND.water
    noise.connect(lp).connect(ng).connect(bed)
    noise.start(); sweep.start()
    return bed
  }

  /**
   * One event. `pan` is -1 (left) to 1 (right), from where the cell sits on screen.
   * `seed` picks the note (a cell id), so each cell has its own voice.
   */
  play(kind: SoundKind, pan = 0, seed = 0, seed2 = 0) {
    if (!this.on || !this.ctx || !this.fx || document.visibilityState !== 'visible') return
    const now = performance.now()
    this.recent = this.recent.filter(t => now - t < 1000)
    if (this.recent.length >= SOUND.maxPerSecond) return
    this.recent.push(now)

    const ctx = this.ctx, t = ctx.currentTime + 0.01
    const p = ctx.createStereoPanner()
    p.pan.value = Math.max(-1, Math.min(1, pan)) * 0.7
    p.connect(this.fx)
    const note = (s: number, oct = 0) => BASE_HZ * Math.pow(2, (SCALE[Math.abs(s) % SCALE.length] + 12 * oct) / 12)

    switch (kind) {
      case 'deposit':
        // a bubble rising: soft tone gliding up into a note, with a glassy overtone
        bubble(ctx, p, t, note(seed) * 0.75, note(seed), 0.9, 0.22)
        tone(ctx, p, t + 0.05, note(seed, 1), 1.4, 0.05, 'sine')
        break
      case 'withdraw':
        // a bubble sinking: the same voice, gliding down and darker
        bubble(ctx, p, t, note(seed), note(seed) * 0.7, 1.0, 0.18, 900)
        break
      case 'split':
        // two notes a fifth apart part from one another, with a soft pop and shimmer
        pop(ctx, p, t, 0.12)
        tone(ctx, pan2(ctx, p, -0.35), t + 0.04, note(seed), 2.2, 0.14, 'triangle')
        tone(ctx, pan2(ctx, p, 0.35), t + 0.14, note(seed + 3), 2.2, 0.12, 'triangle')
        shimmer(ctx, p, t + 0.1, note(seed, 2), 0.035)
        break
      case 'loan':
        // a soft pluck that glides from the lender's note to the borrower's
        bubble(ctx, p, t, note(seed), note(seed2), 1.3, 0.12, 2400, 'triangle')
        break
      case 'repay':
        // the loan coming home: a quieter glide back, lower
        bubble(ctx, p, t, note(seed2, -1) * 2, note(seed, -1) * 2, 1.1, 0.07, 1400, 'sine')
        break
    }
  }
}

function pan2(ctx: AudioContext, into: AudioNode, offset: number) {
  const p = ctx.createStereoPanner()
  p.pan.value = offset
  p.connect(into)
  return p
}

/** A gliding tone with a soft attack and a long tail, through a gentle low-pass. */
function bubble(
  ctx: AudioContext, into: AudioNode, t: number, from: number, to: number, len: number, level: number,
  cutoff = 1800, type: OscillatorType = 'sine',
) {
  const o = ctx.createOscillator()
  o.type = type
  o.frequency.setValueAtTime(from, t)
  o.frequency.exponentialRampToValueAtTime(to, t + Math.min(0.35, len * 0.3))
  const f = ctx.createBiquadFilter()
  f.type = 'lowpass'; f.frequency.value = cutoff; f.Q.value = 0.7
  const g = ctx.createGain()
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(level, t + 0.04)
  g.gain.exponentialRampToValueAtTime(0.0001, t + len)
  o.connect(f).connect(g).connect(into)
  o.start(t); o.stop(t + len + 0.05)
}

function tone(ctx: AudioContext, into: AudioNode, t: number, hz: number, len: number, level: number, type: OscillatorType) {
  const o = ctx.createOscillator()
  o.type = type; o.frequency.value = hz
  const f = ctx.createBiquadFilter()
  f.type = 'lowpass'; f.frequency.value = 2200
  const g = ctx.createGain()
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(level, t + 0.02)
  g.gain.exponentialRampToValueAtTime(0.0001, t + len)
  o.connect(f).connect(g).connect(into)
  o.start(t); o.stop(t + len + 0.05)
}

/** A short soft pop: a quick sine drop, like a bubble breaking. */
function pop(ctx: AudioContext, into: AudioNode, t: number, level: number) {
  const o = ctx.createOscillator()
  o.frequency.setValueAtTime(600, t)
  o.frequency.exponentialRampToValueAtTime(140, t + 0.08)
  const g = ctx.createGain()
  g.gain.setValueAtTime(level, t)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12)
  o.connect(g).connect(into)
  o.start(t); o.stop(t + 0.15)
}

/** A few very quiet high notes, scattered, like light on water. */
function shimmer(ctx: AudioContext, into: AudioNode, t: number, hz: number, level: number) {
  for (let i = 0; i < 4; i++) {
    tone(ctx, into, t + i * 0.09 + Math.random() * 0.04, hz * Math.pow(2, SCALE[(i * 2) % 5] / 12), 0.9, level, 'sine')
  }
}

function noiseBuffer(ctx: AudioContext, seconds: number) {
  const len = Math.floor(ctx.sampleRate * seconds)
  const buf = ctx.createBuffer(1, len, ctx.sampleRate)
  const d = buf.getChannelData(0)
  // pink-ish noise (Paul Kellet's economy filter): softer than white noise
  let b0 = 0, b1 = 0, b2 = 0
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1
    b0 = 0.99765 * b0 + w * 0.099046
    b1 = 0.963 * b1 + w * 0.2965164
    b2 = 0.57 * b2 + w * 1.0526913
    d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.12
  }
  return buf
}

/** A generated reverb tail: decaying stereo noise, long and dark, like a large body of water. */
function impulse(ctx: AudioContext, seconds: number) {
  const len = Math.floor(ctx.sampleRate * seconds)
  const buf = ctx.createBuffer(2, len, ctx.sampleRate)
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c)
    let lp = 0
    for (let i = 0; i < len; i++) {
      const decay = Math.pow(1 - i / len, 3.2)
      lp += ((Math.random() * 2 - 1) - lp) * 0.25 // darken
      d[i] = lp * decay
    }
  }
  return buf
}

export const sound = new Sound()

// During development, editing this file loads a fresh copy. Close the old audio engine so it can
// never keep playing out of reach of the mute button, and carry the on/off state across.
if (import.meta.hot) {
  if (import.meta.hot.data.wasOn) sound.setOn(true)
  import.meta.hot.dispose(data => {
    data.wasOn = sound.on
    sound.close()
  })
}
if (import.meta.env.DEV) (window as unknown as { __sound: Sound }).__sound = sound // for local checks
