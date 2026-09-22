import { describe, expect, test } from "bun:test"
import { animating, arrivalsFor, duration, flap, pushHistory, shimmer, smoothWave } from "../src/tui/visuals"

const base = { width: 40, time: 1000, liveFor: 10_000, rows: 3 }
const text = (rows: { char: string }[][]) => rows.map((row) => row.map((cell) => cell.char).join(""))

describe("smooth waveform", () => {
  test("is a straight center line at rest", () => {
    expect(text(smoothWave({ ...base, phase: "live", level: 0 }))).toEqual([
      " ".repeat(40),
      "─".repeat(40),
      " ".repeat(40),
    ])
  })
  test("swells above and below the line with voice, pinned at the ends", () => {
    const rows = smoothWave({ ...base, phase: "live", level: 0.9 })
    const drawn = (row: { energy: number }[]) => row.filter((cell) => cell.energy > 0).length
    expect(drawn(rows[0])).toBeGreaterThan(0)
    expect(drawn(rows[2])).toBeGreaterThan(0)
    expect(rows[1][0].char).toBe("─")
    expect(rows[1][39].char).toBe("─")
  })
  test("uses braille and the line only, never background-colored blocks", () => {
    for (const row of text(smoothWave({ ...base, phase: "live", level: 1 })))
      expect(row).toMatch(/^[\u2800-\u28ff─ ]+$/)
  })
  test("connecting shows a pulse that moves", () => {
    const at = (time: number) =>
      text(smoothWave({ ...base, phase: "connecting", level: 0, time }))[1].search(/[\u2801-\u28ff]/)
    expect(at(200)).not.toBe(at(700))
  })
  test("connect burst swells right after going live", () => {
    const rows = text(smoothWave({ ...base, phase: "live", level: 0, liveFor: 200 }))
    expect(rows[0].trim().length + rows[2].trim().length).toBeGreaterThan(0)
  })
})

describe("text effects", () => {
  test("shimmer highlight moves over time", () => {
    const a = shimmer(20, 0)
    const b = shimmer(20, 400)
    expect(a.indexOf(Math.max(...a))).not.toBe(b.indexOf(Math.max(...b)))
  })
  test("split-flap settles into the real text", () => {
    const arrivals = arrivalsFor("", [], "Hello", 0)
    expect(flap("Hello", arrivals, 20).map((c) => c.state)).toContain("flipping")
    expect(
      flap("Hello", arrivals, 2000)
        .map((c) => c.char)
        .join(""),
    ).toBe("Hello")
    expect(animating(arrivals, 2000)).toBe(false)
  })
  test("arrivals keep the shared prefix", () => {
    const first = arrivalsFor("", [], "Hi", 0)
    const next = arrivalsFor("Hi", first, "Hi there", 500)
    expect(next.slice(0, 2)).toEqual(first)
    expect(next[2]).toBeGreaterThanOrEqual(500)
  })
})

describe("helpers", () => {
  test("history is bounded", () => {
    let history: number[] = []
    for (let i = 0; i < 10; i++) history = pushHistory(history, i, 4)
    expect(history).toEqual([6, 7, 8, 9])
  })
  test("duration formatting", () => {
    expect(duration(65_000)).toBe("1:05")
    expect(duration(3_725_000)).toBe("1:02:05")
  })
})
