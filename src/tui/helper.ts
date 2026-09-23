import { existsSync } from "node:fs"
import { chmod, mkdir, rename, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"

import type { FileSink } from "bun"

import pkg from "../../package.json" with { type: "json" }

export type HelperEvent = { type: string } & Record<string, unknown>

const BINARY = process.platform === "win32" ? "gpt-live-host.exe" : "gpt-live-host"
const ROOT = path.resolve(import.meta.dir, "../..")

/** npm platform package that ships the prebuilt helper, e.g. opencode-gpt-live-darwin-arm64. */
export function platformPackage(platform = process.platform, arch = process.arch) {
  return `opencode-gpt-live-${platform}-${arch}`
}

function cacheDirectory() {
  const base =
    process.env.XDG_CACHE_HOME ??
    (process.platform === "win32"
      ? (process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"))
      : path.join(os.homedir(), ".cache"))
  return path.join(base, "opencode-gpt-live", pkg.version, `${process.platform}-${process.arch}`)
}

/** Locates an installed helper without touching the network. */
export function findHelper(): string {
  const found = locateHelper()
  if (!found) {
    throw new Error(
      `The GPT-Live audio helper is not installed for ${process.platform}-${process.arch}. ` +
        `Reinstall the plugin, or build it with "cargo build --release" in native/.`,
    )
  }
  return found
}

export function locateHelper(): string | undefined {
  const candidates: string[] = []
  if (process.env.GPT_LIVE_HOST) candidates.push(process.env.GPT_LIVE_HOST)
  try {
    const require = createRequire(path.join(ROOT, "package.json"))
    const manifest = require.resolve(`${platformPackage()}/package.json`)
    candidates.push(path.join(path.dirname(manifest), "bin", BINARY))
  } catch {
    // Optional dependency not installed for this platform.
  }
  candidates.push(path.join(cacheDirectory(), BINARY))
  candidates.push(path.join(ROOT, "native", "target", "release", BINARY))
  return candidates.find((candidate) => existsSync(candidate))
}

/**
 * Downloads the helper for this platform from the matching GitHub release when neither the
 * optional platform package nor a local build is present, verifying its SHA-256 checksum.
 */
export async function ensureHelper(onProgress?: (message: string) => void): Promise<string> {
  const existing = locateHelper()
  if (existing) return existing
  const asset = `gpt-live-host-${process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`
  const base = `https://github.com/malhashemi/opencode-gpt-live/releases/download/v${pkg.version}`
  onProgress?.(`Downloading the GPT-Live audio helper (${process.platform}-${process.arch})…`)
  const [binary, sums] = await Promise.all([fetch(`${base}/${asset}`), fetch(`${base}/SHA256SUMS`)])
  if (!binary.ok) throw new Error(`Could not download the audio helper (${binary.status}) from ${base}/${asset}`)
  if (!sums.ok) throw new Error(`Could not download helper checksums (${sums.status})`)
  const bytes = new Uint8Array(await binary.arrayBuffer())
  const expected = (await sums.text())
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find(([, name]) => name?.replace(/^\*/, "") === asset)?.[0]
  const actual = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
  if (!expected || expected.toLowerCase() !== actual)
    throw new Error("Audio helper checksum mismatch; refusing to run it")
  const directory = cacheDirectory()
  await mkdir(directory, { recursive: true })
  const target = path.join(directory, BINARY)
  const partial = `${target}.${process.pid}.partial`
  await Bun.write(partial, bytes)
  if (process.platform !== "win32") await chmod(partial, 0o755)
  await rename(partial, target).catch(async (error) => {
    await rm(partial, { force: true })
    if (!existsSync(target)) throw error
  })
  return target
}

interface Pending {
  expect: string
  resolve: (event: HelperEvent) => void
  reject: (error: Error) => void
}

export interface HelperCallbacks {
  onEvent?: (event: HelperEvent) => void
  onExit?: (code: number | null, stderr: string) => void
}

/** A running gpt-live-host process speaking newline-delimited JSON over stdio. */
export class HelperProcess {
  private readonly process: ReturnType<typeof Bun.spawn>
  private readonly pending: Pending[] = []
  private stderr = ""
  private exited = false
  readonly ready: Promise<HelperEvent>

  constructor(
    binary: string,
    private readonly callbacks: HelperCallbacks = {},
  ) {
    this.process = Bun.spawn([binary], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, RUST_BACKTRACE: "0" },
    })
    this.ready = this.expect("ready")
    void this.readStdout()
    void this.readStderr()
    void this.watchExit()
  }

  private async watchExit() {
    const code = await this.process.exited
    this.exited = true
    const error = new Error(this.stderr.trim().split("\n").pop() || `audio helper exited (${code})`)
    for (const pending of this.pending.splice(0)) pending.reject(error)
    this.callbacks.onExit?.(code, this.stderr)
  }

  private expect(type: string) {
    return new Promise<HelperEvent>((resolve, reject) => {
      if (this.exited) reject(new Error("audio helper is not running"))
      else this.pending.push({ expect: type, resolve, reject })
    })
  }

  private async readStdout() {
    const stdout = this.process.stdout as ReadableStream<Uint8Array>
    const decoder = new TextDecoder()
    let buffer = ""
    for await (const chunk of stdout) {
      buffer += decoder.decode(chunk, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        let event: HelperEvent
        try {
          event = JSON.parse(line)
        } catch {
          continue
        }
        this.dispatch(event)
      }
    }
  }

  private async readStderr() {
    const stderr = this.process.stderr as ReadableStream<Uint8Array>
    const decoder = new TextDecoder()
    for await (const chunk of stderr) {
      this.stderr = (this.stderr + decoder.decode(chunk, { stream: true })).slice(-4000)
    }
  }

  private dispatch(event: HelperEvent) {
    if (event.type === "error" && this.pending.length > 0 && event.fatal !== true) {
      // Command failures reply with an error instead of the expected response.
      const index = this.pending.findIndex((pending) => pending.expect !== "ready")
      if (index >= 0) {
        const [pending] = this.pending.splice(index, 1)
        pending.reject(new Error(String(event.message)))
        this.callbacks.onEvent?.(event)
        return
      }
    }
    const index = this.pending.findIndex((pending) => pending.expect === event.type)
    if (index >= 0) {
      const [pending] = this.pending.splice(index, 1)
      pending.resolve(event)
    }
    this.callbacks.onEvent?.(event)
  }

  private send(command: Record<string, unknown>) {
    if (this.exited) throw new Error("audio helper is not running")
    const stdin = this.process.stdin as FileSink
    stdin.write(`${JSON.stringify(command)}\n`)
    stdin.flush()
  }

  async start(options: { input?: unknown; output?: unknown; duck?: boolean } = {}): Promise<string> {
    await this.ready
    const offer = this.expect("offer")
    this.send({
      type: "start",
      ...(options.input ? { input: options.input } : {}),
      ...(options.output ? { output: options.output } : {}),
      ...(options.duck ? { duckOthers: true } : {}),
    })
    return String((await offer).sdp)
  }

  async answer(sdp: string): Promise<void> {
    const connected = this.expect("connected")
    this.send({ type: "answer", sdp })
    await connected
  }

  mute(muted: boolean) {
    if (!this.exited) this.send({ type: "mute", muted })
  }

  clear() {
    if (!this.exited) this.send({ type: "clear" })
  }

  async close(timeoutMs = 3000): Promise<void> {
    if (this.exited) return
    try {
      this.send({ type: "close" })
    } catch {
      // Already gone.
    }
    const timer = setTimeout(() => this.process.kill(), timeoutMs)
    await this.process.exited
    clearTimeout(timer)
  }

  kill() {
    if (!this.exited) this.process.kill()
  }
}
