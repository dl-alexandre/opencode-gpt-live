/**
 * OpenCode maps `@opentui/core` to its own runtime copy only for imports in the plugin's
 * entry file. The entry passes the module in, so every renderable belongs to the host.
 */
export type Core = typeof import("@opentui/core")

let module: Core | undefined

export function useCore(value: Core) {
  module = value
}

export function core(): Core {
  if (!module) throw new Error("opencode-gpt-live: @opentui/core was not provided by the entry file")
  return module
}
