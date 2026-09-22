/**
 * Pure animation math for the voice UI. Everything here is deterministic given a time,
 * so it can be unit-tested and rendered by any component.
 */

export const LOWER_BLOCKS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const
export const ORBIT = ["◜", "◠", "◝", "◞", "◡", "◟"] as const

export type Phase = "idle" | "connecting" | "live" | "closing" | "error"

/** A bar column: height in eighths above and below the center line (0..8 each). */
export interface Column {
  up: number
  down: number
  /** 0..1 intensity used for color. */
  heat: number
  /** Which side of the orb this column belongs to. */
  side: "mic" | "speaker" | "center"
}

export function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value))
}

/** Perceptual easing so quiet speech still moves the bars. */
export function shape(level: number) {
  return clamp(Math.sqrt(clamp(level)) * 1.15)
}

/** Keeps a fixed-size rolling history, newest last. */
export function pushHistory(history: number[], value: number, size: number) {
  const next = history.length >= size ? history.slice(history.length - size + 1) : history.slice()
  next.push(value)
  return next
}

export interface WaveInput {
  width: number
  /** Milliseconds since the call UI started; drives idle motion. */
  time: number
  phase: Phase
  /** Milliseconds since the call went live; drives the connect burst. */
  liveFor: number
  mic: readonly number[]
  speaker: readonly number[]
  muted: boolean
}

const BURST_MS = 900

/**
 * Builds a mirrored waveform: the user's microphone history flows into the orb from the
 * left, GPT-Live's voice flows out to the right, newest samples nearest the center.
 */
export function waveColumns(input: WaveInput): Column[] {
  const width = Math.max(9, input.width | 0)
  const center = Math.floor(width / 2)
  const half = center
  const columns: Column[] = []
  const t = input.time / 1000

  for (let x = 0; x < width; x++) {
    if (x === center) {
      columns.push({ up: 0, down: 0, heat: 1, side: "center" })
      continue
    }
    const side = x < center ? "mic" : "speaker"
    const distance = Math.abs(x - center) // 1..half
    const edge = distance / half // 0..1 toward the edges
    let level = 0

    if (input.phase === "connecting") {
      // A scanner sweeping back and forth while the call is dialing.
      const period = 1.6
      const phase = (t % period) / period
      const sweep = phase < 0.5 ? phase * 2 : 2 - phase * 2
      const head = sweep * (width - 1)
      const gap = Math.abs(x - head)
      level = Math.exp(-(gap * gap) / 18) * 0.85 + 0.04 * (1 + Math.sin(t * 6 + x * 0.7))
    } else if (input.phase === "live" || input.phase === "closing") {
      const history = side === "mic" ? input.mic : input.speaker
      const sample = history[history.length - distance] ?? 0
      level = side === "mic" && input.muted ? 0 : shape(sample)
      // Gentle breathing so the strip feels alive in silence.
      const breath = 0.05 + 0.04 * Math.sin(t * 2.2 + distance * 0.45)
      level = Math.max(level, breath * (1 - edge * 0.6))
      // Connect burst: a ring racing outward from the orb right after going live.
      if (input.liveFor < BURST_MS) {
        const progress = input.liveFor / BURST_MS
        const ring = progress * half * 1.15
        const gap = Math.abs(distance - ring)
        level = Math.max(level, Math.exp(-(gap * gap) / 6) * (1 - progress * 0.7))
      }
      if (input.phase === "closing") level *= 0.4
    } else if (input.phase === "error") {
      level = 0.08 * (1 + Math.sin(t * 3 + x))
    }

    const eighths = Math.round(clamp(level) * 8)
    columns.push({ up: eighths, down: Math.max(0, eighths - 1), heat: clamp(level * (1.1 - edge * 0.5)), side })
  }
  return columns
}

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
