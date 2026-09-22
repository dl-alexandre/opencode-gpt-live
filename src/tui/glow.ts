/**
 * Anti-aliased waveform rasterizer for terminals with image support (kitty graphics).
 * Draws layered sine strands with a crisp core and a soft glow onto a transparent RGBA
 * buffer. At rest the strands collapse into one thin line; with voice they swell apart.
 */
import type { Phase } from "./visuals"

export type Rgb = readonly [number, number, number]

export interface GlowInput {
  width: number
  height: number
  time: number
  phase: Phase
  /** Milliseconds since the call went live. */
  liveFor: number
  /** Smoothed voice level, 0..1. */
  level: number
  /** One color per strand while speaking. */
  colors: readonly [Rgb, Rgb, Rgb]
  /** Color of the resting line. */
  rest: Rgb
}

const STRANDS = [
  { frequency: 1.35, speed: 2.1, phase: 0.0, weight: 1.0 },
  { frequency: 2.2, speed: -2.9, phase: 1.7, weight: 0.72 },
  { frequency: 3.3, speed: 4.1, phase: 3.9, weight: 0.5 },
] as const

const BURST_MS = 900
const CORE = 0.95 // px, strand core radius
const GLOW = 4.2 // px, glow radius
const REACH = Math.ceil(GLOW * 3)

function smoothstep(edge0: number, edge1: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/** Scratch accumulators reused across frames for a given size. */
export class GlowCanvas {
  readonly pixels: Uint8Array
  private readonly r: Float32Array
  private readonly g: Float32Array
  private readonly b: Float32Array
  private readonly a: Float32Array

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    const size = width * height
    this.pixels = new Uint8Array(size * 4)
    this.r = new Float32Array(size)
    this.g = new Float32Array(size)
    this.b = new Float32Array(size)
    this.a = new Float32Array(size)
  }

  draw(input: Omit<GlowInput, "width" | "height">) {
    const { width, height } = this
    this.r.fill(0)
    this.g.fill(0)
    this.b.fill(0)
    this.a.fill(0)
    const t = input.time / 1000
    const center = (height - 1) / 2
    const maxAmplitude = center - GLOW * 0.8

    let amplitude = Math.min(1, Math.max(0, input.level))
    let envelopeAt = (u: number) => Math.sin(Math.PI * u) ** 1.6
    if (input.phase === "connecting") {
      // A luminous packet gliding back and forth along the line while dialing.
      const period = 1.9
      const p = (t % period) / period
      const head = p < 0.5 ? p * 2 : 2 - p * 2
      envelopeAt = (u) => Math.exp(-(((u - head) / 0.09) ** 2))
      amplitude = 0.5
    } else if (input.phase === "live" && input.liveFor < BURST_MS) {
      amplitude = Math.max(amplitude, 0.85 * (1 - input.liveFor / BURST_MS))
    } else if (input.phase !== "live" && input.phase !== "closing") {
      amplitude = 0
    }
    // How far the strands are from the resting line decides how colorful they are.
    const vivid = Math.min(1, amplitude * 2.2)

    STRANDS.forEach((strand, index) => {
      const color = input.colors[index]
      const cr = input.rest[0] + (color[0] - input.rest[0]) * vivid
      const cg = input.rest[1] + (color[1] - input.rest[1]) * vivid
      const cb = input.rest[2] + (color[2] - input.rest[2]) * vivid
      // At rest the strands overlap; weight them down so the line stays thin and quiet.
      const weight = strand.weight * (0.6 + 0.4 * vivid)
      let previous = center
      for (let x = 0; x < width; x++) {
        const u = x / (width - 1)
        const envelope = amplitude * envelopeAt(u) * maxAmplitude
        const y = center + envelope * Math.sin(2 * Math.PI * strand.frequency * u - t * strand.speed + strand.phase)
        const slope = x === 0 ? 0 : y - previous
        previous = y
        // Perpendicular distance approximation keeps steep segments as thick as flat ones.
        const normal = 1 / Math.sqrt(1 + slope * slope)
        const fade = smoothstep(0, 0.04, u) * smoothstep(1, 0.96, u)
        const from = Math.max(0, Math.floor(y - REACH))
        const to = Math.min(height - 1, Math.ceil(y + REACH))
        for (let row = from; row <= to; row++) {
          const distance = Math.abs(row - y) * normal
          const intensity =
            (Math.exp(-((distance / CORE) ** 2)) + 0.32 * Math.exp(-((distance / GLOW) ** 2))) * weight * fade
          if (intensity < 0.003) continue
          const i = row * width + x
          this.r[i] += cr * intensity
          this.g[i] += cg * intensity
          this.b[i] += cb * intensity
          this.a[i] += intensity
        }
      }
    })

    const pixels = this.pixels
    for (let i = 0, o = 0; i < this.a.length; i++, o += 4) {
      const alpha = this.a[i]
      if (alpha <= 0.003) {
        pixels[o + 3] = 0
        continue
      }
      // Additive light: overlapping strands brighten toward white-hot at the core.
      const boost = 1 + Math.max(0, alpha - 1) * 0.35
      pixels[o] = Math.min(255, (this.r[i] / alpha) * boost)
      pixels[o + 1] = Math.min(255, (this.g[i] / alpha) * boost)
      pixels[o + 2] = Math.min(255, (this.b[i] / alpha) * boost)
      pixels[o + 3] = Math.min(255, Math.round(Math.min(1, alpha) * 255))
    }
    return pixels
  }
}
