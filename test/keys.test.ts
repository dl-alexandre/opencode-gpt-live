import { describe, expect, test } from "bun:test"
import { resolveKey } from "../src/tui/index"

describe("keybind option", () => {
  test("falls back to the default", () => expect(resolveKey(undefined, "ctrl+s")).toBe("ctrl+s"))
  test("takes a custom key", () => expect(resolveKey("ctrl+y", "ctrl+s")).toBe("ctrl+y"))
  test("joins alternatives", () => expect(resolveKey(["f8", "ctrl+x v"], "f8")).toBe("f8,ctrl+x v"))
  test("can be disabled", () => {
    expect(resolveKey(false, "f8")).toBe(false)
    expect(resolveKey("none", "f8")).toBe(false)
  })
  test("ignores junk", () => expect(resolveKey(42, "f9")).toBe("f9"))
})
