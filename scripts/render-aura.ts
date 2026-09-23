/**
 * Renders the README demo of the voice aura with the plugin's own renderer: a short loop
 * of the ring at rest, reacting to you (cyan), then to GPT-Live (violet).
 *
 *   bun scripts/render-aura.ts [output.webp]     (requires ImageMagick's `magick`)
 */
import { writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { AuraCanvas, type AuraInput } from "../src/tui/aura"

const output = path.resolve(Bun.argv[2] ?? path.join(import.meta.dir, "..", "assets", "aura.webp"))
const SIZE = 360
const FPS = 30
const SECONDS = 8
const BACKGROUND = [13, 13, 22] as const

const palette: AuraInput["palette"] = {
  user: [
    [80, 225, 255],
    [45, 140, 255],
  ],
  assistant: [
    [175, 110, 255],
    [255, 85, 205],
  ],
  rest: [
    [160, 165, 185],
    [115, 120, 140],
  ],
  connecting: [255, 190, 90],
  muted: [150, 140, 145],
}

/** A speech-like loudness envelope: syllables with small gaps between words. */
function speech(t: number, seed: number) {
  const syllable = Math.abs(Math.sin(t * 9.5 + seed)) ** 0.6
  const words = 0.55 + 0.45 * Math.sin(t * 2.3 + seed * 3)
  const gap = Math.sin(t * 1.7 + seed) > -0.75 ? 1 : 0.1
  return Math.min(1, syllable * words * gap)
}

/** Who is talking and how loudly, over the loop. */
function script(t: number): { mic: number; speaker: number } {
  if (t < 1.2) return { mic: 0, speaker: 0 }
  if (t < 3.6) return { mic: 0.75 * speech(t, 0.4), speaker: 0 }
  if (t < 4.2) return { mic: 0, speaker: 0 }
  if (t < 7.2) return { mic: 0, speaker: 0.8 * speech(t, 2.1) }
  return { mic: 0, speaker: 0 }
}

const canvas = new AuraCanvas(SIZE, SIZE)
const directory = await mkdtemp(path.join(os.tmpdir(), "aura-"))
let level = 0
let speaker = 0
const frames = FPS * SECONDS
for (let frame = 0; frame < frames; frame++) {
  const t = frame / FPS
  const dt = 1 / FPS
  // The same smoothing the plugin applies: quick to swell, slower to settle.
  const { mic, speaker: out } = script(t)
  const target = Math.max(mic, out)
  level += (target - level) * (1 - Math.exp(-dt / (target > level ? 0.04 : 0.2)))
  if (target > 0.04) speaker += ((out >= mic ? 1 : 0) - speaker) * (1 - Math.exp(-dt / 0.15))
  const pixels = canvas.draw({
    time: t * 1000,
    phase: "live",
    liveFor: 99_999,
    level: Math.min(1, Math.sqrt(level) * 1.1),
    speaker,
    muted: false,
    palette,
  })
  const rgb = new Uint8Array(SIZE * SIZE * 3)
  for (let i = 0, o = 0; i < pixels.length; i += 4, o += 3) {
    const a = pixels[i + 3] / 255
    for (let c = 0; c < 3; c++) rgb[o + c] = Math.round(pixels[i + c] * a + BACKGROUND[c] * (1 - a))
  }
  const header = `P6\n${SIZE} ${SIZE}\n255\n`
  // Each frame depends on the previous one's smoothing state, so frames are written in order.
  writeFileSync(
    path.join(directory, `${String(frame).padStart(4, "0")}.ppm`),
    Buffer.concat([Buffer.from(header), rgb]),
  )
}

const magick = Bun.spawn(
  [
    "magick",
    "-delay",
    `${100 / FPS}`,
    "-loop",
    "0",
    path.join(directory, "*.ppm"),
    "-quality",
    "82",
    "-define",
    "webp:method=6",
    output,
  ],
  { stdout: "inherit", stderr: "inherit" },
)
if ((await magick.exited) !== 0) throw new Error("magick failed")
await rm(directory, { recursive: true, force: true })
console.log(
  `${frames} frames -> ${path.relative(process.cwd(), output)} (${(Bun.file(output).size / 1024).toFixed(0)} KB)`,
)
