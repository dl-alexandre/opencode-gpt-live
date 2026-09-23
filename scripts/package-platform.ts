/**
 * Assembles the npm package that carries the prebuilt audio helper for one platform, e.g.
 * npm/opencode-gpt-live-darwin-arm64/{package.json, bin/gpt-live-host}.
 *
 *   bun scripts/package-platform.ts <platform-arch> <path-to-binary>
 *
 * The version comes from the root package.json, so it always matches the plugin release.
 */
import { chmod, copyFile, mkdir, rm } from "node:fs/promises"
import path from "node:path"

import root from "../package.json" with { type: "json" }
import { TARGETS, packageName, type Target } from "./targets"

const [target, binary] = Bun.argv.slice(2) as [Target | undefined, string | undefined]
if (!target || !binary || !(target in TARGETS)) {
  console.error(`usage: bun scripts/package-platform.ts <${Object.keys(TARGETS).join("|")}> <binary>`)
  process.exit(2)
}

const { os, cpu, libc } = TARGETS[target] as { os: string; cpu: string; libc?: string }
const name = packageName(target)
const directory = path.resolve(import.meta.dir, "..", "npm", name)
const executable = os === "win32" ? "gpt-live-host.exe" : "gpt-live-host"

await rm(directory, { recursive: true, force: true })
await mkdir(path.join(directory, "bin"), { recursive: true })
await copyFile(binary, path.join(directory, "bin", executable))
if (os !== "win32") await chmod(path.join(directory, "bin", executable), 0o755)
await copyFile(path.resolve(import.meta.dir, "..", "LICENSE"), path.join(directory, "LICENSE"))

const manifest = {
  name,
  version: root.version,
  description: `Prebuilt audio helper (${target}) for ${root.name}`,
  license: root.license,
  author: root.author,
  repository: root.repository,
  homepage: root.homepage,
  os: [os],
  cpu: [cpu],
  ...(libc ? { libc: [libc] } : {}),
  files: ["bin", "LICENSE"],
  publishConfig: { access: "public", provenance: true },
}
await Bun.write(path.join(directory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)
await Bun.write(
  path.join(directory, "README.md"),
  `# ${name}\n\nThe prebuilt \`gpt-live-host\` audio helper for [${root.name}](${root.homepage}) on ${target}.\n` +
    `Installed automatically as an optional dependency; you never need to install it yourself.\n`,
)
console.log(`${name}@${root.version} -> ${path.relative(process.cwd(), directory)}`)
