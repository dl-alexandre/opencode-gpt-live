/** Platforms the audio helper is prebuilt for, keyed by Node's `${process.platform}-${process.arch}`. */
export const TARGETS = {
  "darwin-arm64": { os: "darwin", cpu: "arm64", rust: "aarch64-apple-darwin" },
  "darwin-x64": { os: "darwin", cpu: "x64", rust: "x86_64-apple-darwin" },
  "linux-x64": { os: "linux", cpu: "x64", rust: "x86_64-unknown-linux-gnu", libc: "glibc" },
  "linux-arm64": { os: "linux", cpu: "arm64", rust: "aarch64-unknown-linux-gnu", libc: "glibc" },
  "win32-x64": { os: "win32", cpu: "x64", rust: "x86_64-pc-windows-msvc" },
} as const satisfies Record<string, { os: string; cpu: string; rust: string; libc?: string }>

export type Target = keyof typeof TARGETS

/** Must match platformPackage() in src/tui/helper.ts. */
export function packageName(target: Target) {
  return `opencode-gpt-live-${target}`
}
