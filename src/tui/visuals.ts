/**
 * Pure animation math for the voice UI. Everything here is deterministic given a time,
 * so it can be unit-tested and rendered by any component.
 */

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const
export const ORBIT = ["◜", "◠", "◝", "◞", "◡", "◟"] as const

export type Phase = "idle" | "connecting" | "live" | "closing" | "error"

export function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value))
}

/** Keeps a fixed-size rolling history, newest last. */
export function pushHistory(history: number[], value: number, size: number) {
  const next = history.length >= size ? history.slice(history.length - size + 1) : history.slice()
  next.push(value)
  return next
}

const BURST_MS = 900

/** Shimmer: a soft highlight that sweeps across text. Returns 0..1 per character. */
export function shimmer(length: number, time: number, speed = 28, spread = 4) {
  const cycle = length + spread * 4
  const head = (((time / 1000) * speed) % cycle) - spread * 2
  return Array.from({ length }, (_, index) => {
    const gap = Math.abs(index - head)
    return clamp(1 - gap / spread)
  })
}

export function spinner(time: number, frames: readonly string[] = SPINNER, interval = 80) {
  return frames[Math.floor(time / interval) % frames.length]
}

/** 0..1 pulse for breathing indicators. */
export function pulse(time: number, period = 1400) {
  return 0.5 + 0.5 * Math.sin((time / period) * Math.PI * 2)
}

export function duration(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const mm = String(minutes).padStart(hours ? 2 : 1, "0")
  const ss = String(seconds).padStart(2, "0")
  return hours ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`
}

const FLAP_SETTLE_MS = 190
const FLAP_GLOW_MS = 160
const FLAP_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

export type FlapState = "flipping" | "glowing" | "settled"

/**
 * Split-flap effect: each newly arrived character cycles through letters before landing,
 * then glows briefly. `arrivals[i]` is when character i arrived.
 */
export function flap(text: string, arrivals: readonly number[], now: number) {
  const out: { char: string; state: FlapState }[] = []
  let index = 0
  for (const char of text) {
    const arrived = arrivals[index] ?? 0
    const age = now - arrived
    const flippable = /[A-Za-z0-9]/.test(char)
    if (flippable && age < FLAP_SETTLE_MS) {
      const frame = Math.floor(now / 45)
      const pick = (char.charCodeAt(0) + index * 7 + frame * 11) % FLAP_ALPHABET.length
      out.push({ char: age < 35 ? " " : FLAP_ALPHABET[pick], state: "flipping" })
    } else if (flippable && age < FLAP_SETTLE_MS + FLAP_GLOW_MS) {
      out.push({ char, state: "glowing" })
    } else {
      out.push({ char, state: "settled" })
    }
    index++
  }
  return out
}

/** Arrival times for `next`, reusing the timestamps of any shared prefix with `previous`. */
export function arrivalsFor(previous: string, previousArrivals: readonly number[], next: string, now: number) {
  const prev = [...previous]
  const chars = [...next]
  let shared = 0
  while (shared < prev.length && shared < chars.length && prev[shared] === chars[shared]) shared++
  const arrivals = previousArrivals.slice(0, shared)
  for (let index = shared; index < chars.length; index++) {
    // Stagger new characters so a burst of text ripples in rather than popping.
    arrivals.push(now + Math.min(90, (index - shared) * 6))
  }
  return arrivals
}

/** Whether any character is still animating. */
export function animating(arrivals: readonly number[], now: number) {
  const last = arrivals[arrivals.length - 1]
  return last !== undefined && now - last < FLAP_SETTLE_MS + FLAP_GLOW_MS
}

const BRAILLE_BITS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
] as const

export interface WaveCell {
  char: string
  /** 0..1 how much the cell belongs to the moving wave (vs. the resting line). */
  energy: number
}

export interface SmoothWaveInput {
  width: number
  time: number
  phase: Phase
  /** Milliseconds since the call went live. */
  liveFor: number
  /** Smoothed voice level, 0..1. */
  level: number
  /** Number of text rows (odd numbers keep the resting line centered). */
  rows?: number
}

/**
 * A smooth waveform drawn with braille dots over a straight center line. At rest it is a
 * flat line; with voice, two mirrored waves swell above and below it, tapering to the
 * edges. Braille needs no background color, so it blends into any surface.
 */
export function smoothWave(input: SmoothWaveInput): WaveCell[][] {
  const rows = Math.max(1, input.rows ?? 3) | 1
  const width = Math.max(8, input.width | 0)
  const dotsX = width * 2
  const dotsY = rows * 4
  const center = (dotsY - 1) / 2
  const reach = center - 0.25
  const t = input.time / 1000

  let amplitude = clamp(input.level)
  let packet: ((x: number) => number) | undefined
  if (input.phase === "connecting") {
    // A small pulse gliding back and forth along the line while dialing.
    const period = 1.8
    const p = (t % period) / period
    const head = (p < 0.5 ? p * 2 : 2 - p * 2) * (dotsX - 1)
    packet = (x) => Math.exp(-((x - head) ** 2) / 60)
    amplitude = 0.55
  } else if (input.phase === "live" && input.liveFor < BURST_MS) {
    amplitude = Math.max(amplitude, 0.8 * (1 - input.liveFor / BURST_MS))
  } else if (input.phase !== "live" && input.phase !== "closing") {
    amplitude = 0
  }

  const bits: number[][] = Array.from({ length: rows }, () => new Array(width).fill(0))
  const energy: number[] = new Array(width).fill(0)
  const plot = (x: number, y: number) => {
    const row = Math.round(y)
    if (row < 0 || row >= dotsY) return
    const cell = Math.floor(x / 2)
    bits[Math.floor(row / 4)][cell] |= BRAILLE_BITS[row % 4][x % 2]
  }

  let previous: [number, number] | undefined
  for (let x = 0; x < dotsX; x++) {
    const u = x / (dotsX - 1)
    // Hann taper keeps the swell centered and the ends pinned to the line.
    const taper = 0.5 - 0.5 * Math.cos(2 * Math.PI * u)
    const envelope = amplitude * (packet ? packet(x) : taper)
    const wave =
      0.62 * Math.sin(x * 0.19 - t * 5.2) + 0.28 * Math.sin(x * 0.43 + t * 3.1) + 0.1 * Math.sin(x * 0.9 - t * 8.3)
    const offset = envelope * reach * wave
    const upper = center - Math.abs(offset)
    const lower = center + Math.abs(offset)
    energy[Math.floor(x / 2)] = Math.max(energy[Math.floor(x / 2)], Math.min(1, Math.abs(offset) / Math.max(1, reach)))
    if (Math.abs(offset) < 0.6) {
      previous = undefined
      continue
    }
    // Connect to the previous sample so the strands read as continuous curves.
    const [pu, pl] = previous ?? [upper, lower]
    for (let y = Math.min(pu, upper); y <= Math.max(pu, upper); y += 0.5) plot(x, y)
    for (let y = Math.min(pl, lower); y <= Math.max(pl, lower); y += 0.5) plot(x, y)
    previous = [upper, lower]
  }

  const middle = Math.floor(rows / 2)
  return bits.map((line, row) =>
    line.map((value, x) => {
      if (value) return { char: String.fromCharCode(0x2800 + value), energy: Math.max(0.15, energy[x]) }
      return { char: row === middle ? "─" : " ", energy: 0 }
    }),
  )
}
