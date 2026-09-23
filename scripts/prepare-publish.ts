/**
 * Points the plugin at the platform helper packages of the same version by writing them as
 * optionalDependencies. Runs in the release job right before `npm publish`; the committed
 * package.json stays free of them so local installs do not try to fetch unpublished packages.
 */
import path from "node:path"

import { TARGETS, packageName, type Target } from "./targets"

const file = path.resolve(import.meta.dir, "..", "package.json")
const manifest = await Bun.file(file).json()
manifest.optionalDependencies = Object.fromEntries(
  (Object.keys(TARGETS) as Target[]).map((target) => [packageName(target), manifest.version]),
)
await Bun.write(file, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`optionalDependencies -> ${Object.keys(manifest.optionalDependencies).join(", ")} @ ${manifest.version}`)
