/**
 * Voice UI built from OpenTUI renderables on OpenCode's renderer. Views are plain objects
 * redrawn by a frame clock; nothing here depends on OpenCode's Solid runtime.
 */
import type { RGBA, Renderable, TextRenderable } from "@opentui/core"
import type { Plugin } from "@opencode/plugin/tui"
import type { Entry, VoiceController } from "./controller"
import { GlowCanvas, type Rgb } from "./glow"
import { HerdrStream, detectHerdr, type HerdrPane } from "./herdr"
import { duration, flap, pulse, shimmer, smoothWave, spinner } from "./visuals"

type Context = Plugin.Context
type Theme = Context["theme"]

/**
 * OpenCode maps `@opentui/core` to its own runtime copy only for imports in the plugin's
 * entry file. The entry passes the module in, so every renderable here belongs to the host.
 */
export type Core = typeof import("@opentui/core")
let core: Core

export function useCore(module: Core) {
  core = module
}
type Chunk = { __isChunk: true; text: string; fg?: RGBA; bg?: RGBA; attributes?: number }

function chunk(text: string, fg?: RGBA, options: { bg?: RGBA; bold?: boolean } = {}): Chunk {
  return {
    __isChunk: true,
    text,
    ...(fg ? { fg } : {}),
    ...(options.bg ? { bg: options.bg } : {}),
    ...(options.bold ? { attributes: core.TextAttributes.BOLD } : {}),
  }
}

function styled(chunks: Chunk[]) {
  return new core.StyledText(chunks as never)
}

function width(chunks: readonly Chunk[]) {
  return chunks.reduce((sum, item) => sum + [...item.text].length, 0)
}

export function mix(a: RGBA, b: RGBA, t: number) {
  const [ar, ag, ab] = a.toInts()
  const [br, bg, bb] = b.toInts()
  const k = Math.min(1, Math.max(0, t))
  return core.RGBA.fromInts(
    Math.round(ar + (br - ar) * k),
    Math.round(ag + (bg - ag) * k),
    Math.round(ab + (bb - ab) * k),
    255,
  )
}

function palette(theme: Theme) {
  const bg = theme.background.base
  return {
    bg,
    text: theme.text.base,
    muted: theme.text.muted,
    mic: [theme.hue.cyan[300], theme.hue.cyan[500], theme.hue.blue[400]] as const,
    speaker: [theme.hue.purple[300], theme.hue.purple[500], theme.hue.accent[500]] as const,
    live: theme.hue.green[500],
    warn: theme.hue.yellow[500],
    error: theme.hue.red[500],
    accent: theme.hue.accent[500],
    dim: mix(theme.text.muted, bg, 0.45),
  }
}

type Palette = ReturnType<typeof palette>

function shimmerChunks(text: string, time: number, color: RGBA, glow: RGBA): Chunk[] {
  const letters = [...text]
  const light = shimmer(letters.length, time)
  return letters.map((char, index) => chunk(char, mix(color, glow, light[index])))
}

/** Pads between left and right content so the row spans `total` cells. */
function row(left: Chunk[], right: Chunk[], total: number) {
  const gap = total - width(left) - width(right)
  if (gap < 1) return left
  return [...left, chunk(" ".repeat(gap)), ...right]
}

export interface View {
  readonly root: Renderable
  update(now: number): void
  /** True while the view needs frame-by-frame redraws. */
  animating(now: number): boolean
  /** Releases resources outside the renderable tree (e.g. herdr image layers). */
  dispose?(): void
}

/** The main-UI call strip above the prompt: status, smooth waveform, activity. */
export function voiceStrip(context: Context, voice: VoiceController, sessionID: () => string | undefined): View {
  const renderer = context.renderer
  const root = new core.BoxRenderable(renderer, {
    flexDirection: "column",
    paddingLeft: 1,
    paddingRight: 1,
    flexShrink: 0,
  })
  // Single-line rows get an explicit height so they never collapse onto each other.
  const line = () => new core.TextRenderable(renderer, { content: "", wrapMode: "none", height: 1, flexShrink: 0 })
  const header = line()
  const wave = [line(), line(), line()]
  const activity = line()
  // Terminals with kitty graphics get an anti-aliased image waveform; others use braille.
  const glow = glowWave(context, 3)
  const waveBox = new core.BoxRenderable(renderer, {
    flexDirection: "column",
    height: 3,
    flexShrink: 0,
    alignItems: "center",
  })
  if (glow) waveBox.add(glow.node)
  for (const child of wave) waveBox.add(child)
  for (const child of [header, waveBox, activity]) root.add(child)
  root.visible = false

  const shortcut = (id: string, fallback: string) => context.keymap.shortcuts(id)[0] ?? fallback
  // Smoothed levels so the waveform swells and settles instead of flickering.
  let level = 0
  let speaker = 0

  return {
    root,
    dispose: () => glow?.hide(),
    animating: () => voice.owns(sessionID()),
    update(now) {
      const show = voice.owns(sessionID())
      if (root.visible !== show) root.visible = show
      if (!show) {
        glow?.hide()
        return
      }
      const state = voice.state
      const p = palette(context.theme)
      const total = Math.max(24, (root.width || renderer.width) - 2)

      // Status line.
      const status =
        state.phase === "connecting"
          ? { label: "CONNECTING", fg: p.warn, dot: spinner(now) }
          : state.phase === "closing"
            ? { label: "ENDING", fg: p.muted, dot: "◌" }
            : state.muted
              ? { label: "MUTED", fg: p.error, dot: "⊘" }
              : { label: "LIVE", fg: p.live, dot: "●" }
      const left: Chunk[] = [
        chunk(
          `${status.dot} `,
          mix(status.fg, p.bg, state.phase === "live" && !state.muted ? 0.35 * (1 - pulse(now, 900)) : 0),
        ),
        chunk(status.label, status.fg, { bold: true }),
        chunk(" · GPT-Live", p.muted),
      ]
      if (state.voice) left.push(chunk(` · ${state.voice}`, p.muted))
      if (state.call) left.push(chunk(` · call ${state.call}`, p.dim))
      if (state.phase === "live" && state.liveAt) left.push(chunk(`  ${duration(now - state.liveAt)}`, p.text))
      const full: Chunk[] = [
        chunk(shortcut("gptlive.mute", "/voice-mute"), p.muted),
        chunk(state.muted ? " unmute" : " mute", p.dim),
        chunk(`   ${shortcut("gptlive.toggle", "/voice")}`, p.muted),
        chunk(' end · or say "end the call"', p.dim),
      ]
      const short: Chunk[] = [chunk(`${shortcut("gptlive.toggle", "/voice")}`, p.muted), chunk(" end", p.dim)]
      header.content = styled(row(left, width(left) + width(full) + 2 <= total ? full : short, total))

      // Waveform: a straight line at rest, a smooth mirrored wave while anyone speaks.
      const mic = state.muted ? 0 : state.micLevel
      const target = Math.max(mic, state.speakerLevel)
      level += (target - level) * (target > level ? 0.45 : 0.18)
      speaker += ((state.speakerLevel >= mic ? 1 : 0) - speaker) * 0.25
      const active = mix(mix(p.mic[1], p.speaker[1], speaker), mix(p.mic[2], p.speaker[2], speaker), pulse(now, 1600))
      // The resting line must read clearly on dark and translucent backgrounds.
      const restColor = state.phase === "connecting" ? mix(p.muted, p.warn, 0.4) : mix(p.muted, p.text, 0.25)
      const waveWidth = Math.max(20, Math.min(total, 120))
      const rows = smoothWave({
        width: waveWidth,
        rows: 3,
        time: now - state.startedAt,
        phase: state.phase,
        liveFor: state.liveAt ? now - state.liveAt : Number.POSITIVE_INFINITY,
        // Perceptual curve: quiet speech should still move the line.
        level: Math.min(1, Math.sqrt(level) * 1.1),
      })
      if (glow?.active()) {
        for (const text of wave) if (text.visible) text.visible = false
        glow.draw({
          columns: waveWidth,
          time: now - state.startedAt,
          phase: state.phase,
          liveFor: state.liveAt ? now - state.liveAt : Number.POSITIVE_INFINITY,
          level: Math.min(1, Math.sqrt(level) * 1.1),
          colors: [
            rgb(mix(p.mic[1], p.speaker[1], speaker)),
            rgb(mix(p.mic[2], p.speaker[0], speaker)),
            rgb(mix(p.mic[0], p.speaker[2], speaker)),
          ],
          rest: rgb(restColor),
        })
      } else {
        glow?.hide()
        for (const text of wave) if (!text.visible) text.visible = true
      }
      const pad = chunk(" ".repeat(Math.max(0, Math.floor((total - waveWidth) / 2))))
      if (!glow?.active())
        rows.forEach((cells, index) => {
          wave[index].content = styled([
            pad,
            ...cells.map((cell) =>
              cell.energy > 0
                ? chunk(cell.char, mix(restColor, active, 0.45 + cell.energy * 0.55))
                : chunk(cell.char, restColor),
            ),
          ])
        })

      // Activity line.
      const you: Chunk[] = [
        chunk("you ", p.mic[1]),
        chunk(state.muted ? "muted" : state.micLevel > 0.12 ? "speaking" : "listening", state.muted ? p.error : p.dim),
      ]
      if (state.speakerLevel > 0.12) you.push(chunk("   ", p.dim), chunk("GPT-Live speaking", p.speaker[1]))
      if (state.voiceActivity) {
        you.push(
          chunk("   "),
          chunk(`${spinner(now)} `, p.speaker[1]),
          ...shimmerChunks(state.voiceActivity, now, p.muted, p.speaker[0]),
        )
      }
      const main: Chunk[] = state.mainActivity
        ? [
            chunk(`${spinner(now + 400)} `, p.accent),
            chunk("OpenCode ", p.text),
            ...shimmerChunks(state.mainActivity, now + 900, p.muted, p.accent),
            ...(state.queued ? [chunk(` · ${state.queued} queued`, p.dim)] : []),
          ]
        : [chunk(state.queued ? `OpenCode · ${state.queued} queued` : "OpenCode idle", p.dim)]
      activity.content = styled(row(you, main, total))
    },
  }
}

/** Developer diagnostics: GPT_LIVE_DEBUG=/path/file.jsonl records UI capability decisions. */
export function debug(entry: Record<string, unknown>) {
  const file = process.env.GPT_LIVE_DEBUG
  if (!file) return
  try {
    require("node:fs").appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
  } catch {
    // Diagnostics must never break the UI.
  }
}

function rgb(color: RGBA): Rgb {
  const [r, g, b] = color.toInts()
  return [r, g, b]
}

interface GlowFrame {
  columns: number
  time: number
  phase: VoiceController["state"]["phase"]
  liveFor: number
  level: number
  colors: readonly [Rgb, Rgb, Rgb]
  rest: Rgb
}

interface WaveSurface {
  /** The renderable that occupies the waveform's space in the layout. */
  readonly node: Renderable
  active(): boolean
  hide(): void
  draw(frame: GlowFrame): void
}

/**
 * Picks the best waveform surface for this terminal:
 * - inside herdr: frames streamed through herdr's pane graphics API (herdr does not show
 *   kitty images printed by programs);
 * - terminals with kitty graphics (Ghostty, kitty, WezTerm): an image renderable;
 * - otherwise none, and the caller draws the braille waveform.
 * The `waveform` plugin option or GPT_LIVE_WAVEFORM can force "image" or "braille".
 */
function glowWave(context: Context, rows: number): WaveSurface | undefined {
  const renderer = context.renderer
  const mode = (context.options as { waveform?: string }).waveform ?? process.env.GPT_LIVE_WAVEFORM
  if (mode === "braille") return undefined
  const herdr = detectHerdr()
  debug({
    event: "wave-surface",
    mode: mode ?? "auto",
    herdr: !!herdr,
    capabilities: renderer.capabilities,
    env: { TERM: process.env.TERM, TERM_PROGRAM: process.env.TERM_PROGRAM, TMUX: !!process.env.TMUX },
  })
  if (herdr) return herdrWave(renderer, rows, herdr)
  if (!renderer.capabilities?.kitty_graphics && mode !== "image") return undefined
  return kittyWave(renderer, rows)
}

function kittyWave(renderer: Context["renderer"], rows: number): WaveSurface {
  let failed = false
  const image = new core.ImageRenderable(renderer, {
    height: rows,
    fit: "fill",
    protocol: "kitty",
    flexShrink: 0,
    onError: (error) => {
      failed = true
      debug({ event: "image-error", error: String(error) })
    },
  })
  image.visible = false
  let pool: InstanceType<Core["NativeImagePool"]> | undefined
  let canvas: GlowCanvas | undefined
  // publishRgba returns a retained frame; the image renderable takes its own reference,
  // so ours must be released once the next frame replaces it. Holding on to it keeps the
  // pool's slots busy and the waveform freezes after a few frames.
  let last: ReturnType<InstanceType<Core["NativeImagePool"]>["publishRgba"]> = null
  const dispose = () => {
    last?.dispose()
    last = null
    pool?.dispose()
    pool = undefined
  }
  return {
    node: image,
    active: () => !failed && !image.isDestroyed,
    hide() {
      if (image.visible) image.visible = false
    },
    draw(frame) {
      try {
        // Pixels per cell: roughly 8x16, enough for a smooth anti-aliased curve.
        const width = frame.columns * 8
        const height = rows * 16
        if (!canvas || canvas.width !== width || canvas.height !== height) {
          dispose()
          canvas = new GlowCanvas(width, height)
          pool = new core.NativeImagePool({ width, height, capacity: 3 })
        }
        if (image.width !== frame.columns) image.width = frame.columns
        const published = pool!.publishRgba(canvas.draw(frame))
        if (published) {
          image.source = published
          last?.dispose()
          last = published
        }
        if (!image.visible) image.visible = true
      } catch (error) {
        failed = true
        image.visible = false
        dispose()
        debug({ event: "draw-error", error: String(error) })
      }
    },
  }
}

function herdrWave(renderer: Context["renderer"], rows: number, pane: HerdrPane): WaveSurface {
  // An empty box reserves the waveform's cells; herdr draws the image over them.
  const slot = new core.BoxRenderable(renderer, { height: rows, flexShrink: 0 })
  let failed = false
  const stream = new HerdrStream(pane, "gptlive-wave", (error) => {
    failed = true
    debug({ event: "herdr-error", error })
  })
  let canvas: GlowCanvas | undefined
  let lastSent = 0
  return {
    node: slot,
    active: () => !failed && !slot.isDestroyed,
    hide() {
      stream.close()
    },
    draw(frame) {
      if (slot.width !== frame.columns) slot.width = frame.columns
      // herdr re-uploads each frame inline; ~20 fps at modest resolution keeps it light.
      const now = Date.now()
      if (now - lastSent < 45) return
      const width = frame.columns * 6
      const height = rows * 14
      if (!canvas || canvas.width !== width || canvas.height !== height) canvas = new GlowCanvas(width, height)
      if (slot.width <= 0) return
      // The socket may still hold the previous buffer, so each frame gets its own copy.
      const pixels = canvas.draw(frame).slice()
      if (stream.send(pixels, width, height, { col: slot.x, row: slot.y, cols: frame.columns, rows })) lastSent = now
    },
  }
}

const TASK_ICONS = { queued: "◌", done: "✓", failed: "✗", cancelled: "⊘" } as const

function entryChunks(entry: Entry, now: number, p: Palette): Chunk[] {
  if (entry.kind === "user" || entry.kind === "assistant") {
    const user = entry.kind === "user"
    const label = chunk(user ? "you  " : "live ", entry.past ? p.dim : user ? p.mic[1] : p.speaker[1], { bold: true })
    const base = entry.past ? p.dim : entry.final ? p.text : mix(p.text, p.muted, 0.3)
    const glow = user ? p.mic[0] : p.speaker[0]
    const text = flap(entry.text, entry.arrivals, now).map((item) =>
      chunk(item.char, item.state === "flipping" ? p.dim : item.state === "glowing" ? glow : base),
    )
    const cursor = entry.final
      ? []
      : [chunk(` ${spinner(now, ["▏", "▎", "▍", "▌", "▋", "▊", "▉", "▊", "▋", "▌", "▍", "▎"], 70)}`, p.dim)]
    return [label, ...text, ...cursor]
  }
  if (entry.kind === "task") {
    const color =
      entry.status === "done"
        ? p.live
        : entry.status === "failed"
          ? p.error
          : entry.status === "cancelled"
            ? p.muted
            : p.accent
    const icon = entry.status === "running" ? spinner(now) : TASK_ICONS[entry.status]
    return [
      chunk("▌ ", color),
      chunk(`${icon} `, color),
      chunk("OpenCode", p.text, { bold: true }),
      chunk(` · ${entry.status}\n`, p.dim),
      chunk("▌ ", color),
      chunk(entry.text, p.muted),
      ...(entry.detail ? [chunk(`\n▌ ${entry.detail}`, p.error)] : []),
    ]
  }
  const notice = entry as Extract<Entry, { kind: "notice" }>
  const error = notice.tone === "error"
  return [chunk(error ? "! " : "· ", error ? p.error : p.dim), chunk(notice.text, error ? p.error : p.muted)]
}

function entryAnimating(entry: Entry, now: number) {
  if (entry.kind === "task") return entry.status === "running" || entry.status === "queued"
  if (entry.kind === "notice") return false
  if (!entry.final) return true
  const last = entry.arrivals[entry.arrivals.length - 1]
  return last !== undefined && now - last < 400
}

/** The side-panel transcript. */
export function transcriptPanel(context: Context, voice: VoiceController): View {
  const renderer = context.renderer
  const root = new core.BoxRenderable(renderer, {
    flexDirection: "column",
    flexGrow: 1,
    paddingLeft: 1,
    paddingRight: 1,
  })
  // Fixed heights: two empty single-line texts otherwise collapse onto the same row, and
  // the header's glyphs show through the gaps in the device line.
  const header = new core.TextRenderable(renderer, { content: "", wrapMode: "none", height: 1, flexShrink: 0 })
  const devices = new core.TextRenderable(renderer, { content: "", wrapMode: "none", height: 1, flexShrink: 0 })
  const scroll = new core.ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    stickyScroll: true,
    // Never take keyboard focus from the prompt.
    focusable: false,
    stickyStart: "bottom",
    marginTop: 1,
  })
  root.add(header)
  root.add(devices)
  root.add(scroll)
  const rendered = new Map<string, { text: TextRenderable; key: string }>()
  let empty: TextRenderable | undefined

  return {
    root,
    animating: (now) => voice.active || voice.state.entries.some((entry) => entryAnimating(entry, now)),
    update(now) {
      const state = voice.state
      const p = palette(context.theme)
      const phase =
        state.phase === "connecting"
          ? [chunk(` ${spinner(now)} connecting`, p.warn)]
          : state.phase === "live"
            ? [chunk(" ● live ", p.live), chunk(state.liveAt ? duration(now - state.liveAt) : "", p.muted)]
            : state.phase === "error"
              ? [chunk(" ! failed", p.error)]
              : [chunk(" · not in a call", p.dim)]
      header.content = styled([
        chunk("◉ ", p.speaker[1]),
        chunk(state.voiceTitle ?? "Voice", p.text, { bold: true }),
        ...(state.call ? [chunk(` · call ${state.call}`, p.muted)] : []),
        ...phase,
      ])
      devices.content = styled(state.devices ? [chunk(`${state.devices.input} → ${state.devices.output}`, p.dim)] : [])

      if (state.entries.length === 0) {
        if (!empty) {
          empty = new core.TextRenderable(renderer, { content: "", wrapMode: "word" })
          scroll.add(empty)
        }
        empty.content = styled([chunk("No voice call yet. Run /voice or press F8 to start one.", p.dim)])
      } else if (empty) {
        scroll.remove(empty)
        empty.destroy()
        empty = undefined
      }

      const live = new Set<string>()
      for (const [index, entry] of state.entries.entries()) {
        live.add(entry.id)
        let item = rendered.get(entry.id)
        if (!item) {
          const text = new core.TextRenderable(renderer, { content: "", wrapMode: "word", marginBottom: 1 })
          // Insert in transcript order (earlier-call lines arrive after the first notice).
          scroll.add(text, index)
          item = { text, key: "" }
          rendered.set(entry.id, item)
        }
        const animating = entryAnimating(entry, now)
        const key = `${state.revision}:${entry.kind === "task" ? entry.status : ""}`
        if (!animating && item.key === key) continue
        item.key = animating ? "" : key
        item.text.content = styled(entryChunks(entry, now, p))
      }
      for (const [id, item] of rendered) {
        if (live.has(id)) continue
        scroll.remove(item.text)
        item.text.destroy()
        rendered.delete(id)
      }
    },
  }
}

/** A small live indicator for the footer. */
export function footerBadge(context: Context, voice: VoiceController): View {
  const text = new core.TextRenderable(context.renderer, { content: "", wrapMode: "none", height: 1 })
  text.visible = false
  return {
    root: text,
    animating: () => voice.active,
    update(now) {
      const show = voice.active
      if (text.visible !== show) text.visible = show
      if (!show) return
      const state = voice.state
      const p = palette(context.theme)
      const dot =
        state.phase === "connecting"
          ? chunk(spinner(now), p.warn)
          : state.muted
            ? chunk("⊘", p.error)
            : chunk("●", mix(p.live, p.accent, pulse(now, 900)))
      text.content = styled([
        dot,
        chunk(" voice", p.muted),
        ...(state.phase === "live" && state.liveAt ? [chunk(` ${duration(now - state.liveAt)}`, p.dim)] : []),
      ])
    },
  }
}

/**
 * Drives every mounted view: redraws on state changes, and at ~20 fps while anything is
 * animating. Views whose renderables were removed by the host are dropped automatically.
 */
export class Frames {
  private readonly views = new Set<View>()
  private timer: ReturnType<typeof setInterval> | undefined
  private readonly stopListening: () => void

  constructor(private readonly voice: VoiceController) {
    this.stopListening = voice.onChange(() => this.tick())
  }

  mount(view: View) {
    this.views.add(view)
    this.tick()
    return view.root
  }

  private tick() {
    const now = Date.now()
    let animating = false
    for (const view of this.views) {
      if (view.root.isDestroyed) {
        view.dispose?.()
        this.views.delete(view)
        continue
      }
      try {
        view.update(now)
        animating ||= view.animating(now)
      } catch {
        // Keep other views and the call alive if one view fails to draw.
      }
    }
    if (animating && !this.timer) this.timer = setInterval(() => this.tick(), 33)
    if (!animating && this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  dispose() {
    this.stopListening()
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    for (const view of this.views) {
      view.dispose?.()
      if (!view.root.isDestroyed) view.root.destroyRecursively()
    }
    this.views.clear()
  }
}
