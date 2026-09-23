import { describe, expect, test } from "bun:test"

import { resolveKey } from "../src/tui/index"

describe("keybind option", () => {
  test("falls back to the default", () => expect(resolveKey(undefined, "ctrl+s")).toBe("ctrl+s"))
  test("takes a custom key", () => expect(resolveKey("ctrl+y", "ctrl+s")).toBe("ctrl+y"))
  test("joins alternatives", () => expect(resolveKey(["ctrl+y", "f9"], "ctrl+y")).toBe("ctrl+y,f9"))
  test("can be disabled", () => {
    expect(resolveKey(false, "ctrl+y")).toBe(false)
    expect(resolveKey("none", "ctrl+y")).toBe(false)
  })
  test("ignores junk", () => expect(resolveKey(42, "ctrl+y")).toBe("ctrl+y"))
})
