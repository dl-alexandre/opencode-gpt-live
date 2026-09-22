import { describe, expect, test } from "bun:test"
import { animating, arrivalsFor, duration, flap, pushHistory, shimmer, waveColumns } from "../src/tui/visuals"

const base = { width: 21, time: 1000, liveFor: 10_000, mic: [], speaker: [], muted: false }

describe("waveform", () => {
  test("has an orb in the middle and one column per cell", () => {
    const columns = waveColumns({ ...base, phase: "live" })
    expect(columns).toHaveLength(21)
    expect(columns[10].side).toBe("center")
    expect(columns[0].side).toBe("mic")
    expect(columns[20].side).toBe("speaker")
  })
  test("newest samples sit next to the orb", () => {
    const columns = waveColumns({ ...base, phase: "live", mic: [0, 0, 1], speaker: [1, 0, 0] })
    expect(columns[9].up).toBe(8)
    expect(columns[11].up).toBeLessThan(8)
    expect(columns[13].up).toBe(8)
  })
  test("muted microphone stays flat apart from breathing", () => {
    const columns = waveColumns({ ...base, phase: "live", mic: [1, 1, 1], muted: true })
    expect(columns[9].up).toBeLessThanOrEqual(1)
  })
  test("connect burst lights up columns right after going live", () => {
    const quiet = waveColumns({ ...base, phase: "live" })
    const burst = waveColumns({ ...base, phase: "live", liveFor: 300 })
    const energy = (columns: typeof quiet) => columns.reduce((sum, column) => sum + column.up, 0)
    expect(energy(burst)).toBeGreaterThan(energy(quiet))
  })
  test("connecting shows a moving scanner", () => {
    const a = waveColumns({ ...base, phase: "connecting", time: 100 })
    const b = waveColumns({ ...base, phase: "connecting", time: 600 })
    const peak = (columns: typeof a) =>
      columns.findIndex((column) => column.up === Math.max(...columns.map((c) => c.up)))
    expect(peak(a)).not.toBe(peak(b))
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
