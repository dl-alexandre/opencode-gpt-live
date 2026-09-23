import { describe, expect, test } from "bun:test"

import { TARGETS, packageName, type Target } from "../scripts/targets"
import { platformPackage } from "../src/tui/helper"

describe("release targets", () => {
  test("package names match what the plugin looks for at runtime", () => {
    for (const [target, { os, cpu }] of Object.entries(TARGETS))
      expect(packageName(target as Target)).toBe(platformPackage(os, cpu))
  })
  test("keys use Node's platform-arch naming", () => {
    for (const [target, { os, cpu }] of Object.entries(TARGETS)) expect(target).toBe(`${os}-${cpu}`)
  })
})
