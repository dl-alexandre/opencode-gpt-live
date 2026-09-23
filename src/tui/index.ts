import type { Plugin as PluginNamespace } from "@opencode/plugin/tui"
import { VOICES, type Voice } from "../shared/rpc"
import { VoiceController } from "./controller"
import { Frames, footerBadge, transcriptPanel, useCore, voiceAura, voiceStrip, type Core, type View } from "./ui"

const PANEL = "gptlive.transcript"

type Context = PluginNamespace.Context

/** Actions that can have a keyboard shortcut, set with the `keybinds` plugin option. */
type KeyAction = "toggle" | "stop" | "new" | "mute" | "panel" | "voice"
/** A key ("ctrl+s"), alternatives ("ctrl+y,f9" or ["ctrl+y", "f9"]), or false / "none" for no key. */
type KeyOption = string | readonly string[] | false

const DEFAULT_KEYS: Record<KeyAction, KeyOption> = {
  // Mute is the in-call reflex, so it gets the single chord; starting a call is deliberate
  // (usually /voice) and follows OpenCode's leader pattern (v for voice).
  toggle: "<leader>v",
  mute: "ctrl+y",
  panel: "ctrl+s",
  stop: false,
  new: false,
  voice: false,
}

export function resolveKey(value: unknown, fallback: KeyOption): false | string {
  const chosen = value === undefined ? fallback : value
  if (chosen === false || chosen === null || chosen === "none" || chosen === "") return false
  if (Array.isArray(chosen)) {
    const keys = chosen.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    return keys.length ? keys.join(",") : false
  }
  return typeof chosen === "string" ? chosen : resolveKey(undefined, fallback)
}

/** Builds the terminal plugin; `core` must be imported by the entry file (see tui.ts). */
export function createTuiPlugin(module: Core): PluginNamespace.Definition {
  useCore(module)
  return {
    id: "opencode-gpt-live.tui",
    setup(context: Context) {
      const options = context.options as {
        voice?: string
        panel?: boolean
        duck?: boolean
        keybinds?: Partial<Record<KeyAction, KeyOption>>
      }
      const key = (action: KeyAction) => resolveKey(options.keybinds?.[action], DEFAULT_KEYS[action])
      const voice = new VoiceController(context, {
        voice: VOICES.includes(options.voice as Voice) ? (options.voice as Voice) : undefined,
        // Other apps' audio is turned down during calls and restored afterwards.
        duck: options.duck !== false,
      })
      const frames = new Frames(voice)
      const autoPanel = options.panel !== false

      const currentSession = () => {
        const route = context.ui.router.current()
        return route.type === "session" ? route.sessionID : undefined
      }

      // With no session open (e.g. on the home screen), a call starts in a new session.
      const openNewSession = async () => {
        try {
          const location = context.location ?? context.data.location.default()
          const created = await context.client.session.create({ location })
          const previous = context.renderer.currentFocusedEditor
          context.ui.router.navigate({ type: "session", sessionID: created.id })
          // Wait for the new session's prompt to mount and take focus, so opening the panel
          // hands focus back to it rather than to the home screen's (now gone) prompt.
          const ready = () => {
            const editor = context.renderer.currentFocusedEditor
            return currentSession() === created.id && editor && editor !== previous && !editor.isDestroyed
          }
          for (let i = 0; i < 80 && !ready(); i++) await Bun.sleep(25)
          return created.id
        } catch (error) {
          context.ui.toast.show({
            title: "GPT-Live",
            message: `Could not start a new session: ${error instanceof Error ? error.message : String(error)}`,
            variant: "error",
          })
          return undefined
        }
      }

      const start = async (chosen?: Voice, fresh = false) => {
        const sessionID = currentSession() ?? (await openNewSession())
        if (!sessionID) return
        if (autoPanel) openPanelKeepingFocus()
        await voice.start(sessionID, chosen, fresh)
      }

      // Close the transcript panel when a call ends normally; keep it open after a failure
      // so the error stays readable.
      let wasActive = false
      const stopWatchingCall = voice.onChange(() => {
        const active = voice.active
        if (wasActive && !active && voice.state.phase === "idle" && context.ui.panel.current()?.name === PANEL)
          context.ui.panel.close()
        wasActive = active
      })

      // Opening a panel moves keyboard focus into it; hand focus back so typing still goes
      // to the prompt during a call.
      const openPanelKeepingFocus = () => {
        const focused = context.renderer.currentFocusedEditor ?? context.renderer.currentFocusedRenderable
        const opened = context.ui.panel.open(PANEL)
        if (opened && focused && !focused.isDestroyed) {
          setTimeout(() => {
            if (!focused.isDestroyed) context.renderer.focusRenderable(focused)
          }, 0)
        }
        return opened
      }

      const toggle = () => (voice.active ? voice.stop() : start())

      const restartWith = async (name: Voice, fresh = false) => {
        if (voice.active) await voice.stop()
        await start(name, fresh)
      }

      const pickVoice = async () => {
        const chosen = await context.ui.dialog.select<Voice>({
          title: "GPT-Live voice",
          current: (voice.state.voice as Voice | undefined) ?? (options.voice as Voice | undefined) ?? "cove",
          options: VOICES.map((name) => ({ title: name, value: name })),
        })
        if (chosen) await restartWith(chosen)
      }

      const togglePanel = () => {
        if (context.ui.panel.current()?.name === PANEL) context.ui.panel.close()
        else if (!openPanelKeepingFocus())
          context.ui.toast.show({
            title: "GPT-Live",
            message: "Open a session to see the voice transcript.",
            variant: "info",
          })
      }

      const disposers = [
        context.ui.slot({
          append: "app",
          render: () => {
            context.keymap.layer(() => ({
              mode: "global",
              commands: [
                {
                  id: "gptlive.toggle",
                  title: "Voice call: start or end (GPT-Live)",
                  description: "Talk to OpenCode with GPT-Live using your ChatGPT subscription",
                  group: "Voice",
                  bind: key("toggle"),
                  palette: true,
                  suggested: true,
                  slash: { name: "voice" },
                  run: () => toggle(),
                },
                {
                  id: "gptlive.stop",
                  title: "Voice call: end",
                  group: "Voice",
                  bind: key("stop"),
                  palette: true,
                  slash: { name: "voice-stop", aliases: ["hangup"] },
                  run: () => voice.stop(),
                },
                {
                  id: "gptlive.new",
                  title: "Voice call: start with a fresh voice session",
                  description: "Forget earlier calls for this session and start over",
                  group: "Voice",
                  bind: key("new"),
                  palette: true,
                  slash: { name: "voice-new" },
                  run: () =>
                    restartWith((voice.state.voice as Voice | undefined) ?? (options.voice as Voice) ?? "cove", true),
                },
                {
                  id: "gptlive.mute",
                  title: "Voice call: mute or unmute microphone",
                  group: "Voice",
                  bind: key("mute"),
                  palette: true,
                  slash: { name: "voice-mute" },
                  run: () => voice.toggleMute(),
                },
                {
                  id: "gptlive.panel",
                  title: "Voice call: toggle transcript",
                  group: "Voice",
                  bind: key("panel"),
                  palette: true,
                  slash: { name: "voice-panel" },
                  run: () => togglePanel(),
                },
                {
                  id: "gptlive.voice",
                  title: "Voice call: choose voice",
                  group: "Voice",
                  bind: key("voice"),
                  palette: true,
                  slash: { name: "voice-pick" },
                  run: () => pickVoice(),
                },
              ],
            }))
            return null
          },
        }),
        context.ui.slot({
          append: "session.composer.top",
          render: (input) => frames.mount(voiceStrip(context, voice, () => input.sessionID)),
        }),
        context.ui.slot({
          append: "session.panel",
          render: (panel) => {
            const open = () => panel.name === PANEL
            const view = transcriptPanel(context, voice, () => open() && voice.owns(panel.sessionID))
            const gated: View = {
              root: view.root,
              animating: (now) => open() && view.animating(now),
              interval: view.interval,
              suspend: view.suspend,
              dispose: view.dispose,
              update(now) {
                const show = open()
                if (view.root.visible !== show) view.root.visible = show
                if (show) view.update(now)
                else view.suspend?.()
              },
            }
            return frames.mount(gated)
          },
        }),
        context.ui.slot({
          prepend: "sidebar.content",
          render: (input) =>
            frames.mount(voiceAura(context, voice, () => voice.owns(input.sessionID), "gptlive-aura-sidebar")),
        }),
        context.ui.slot({
          append: "prompt.footer.status",
          render: () => frames.mount(footerBadge(context, voice)),
        }),
        context.ui.slot({
          append: "home.footer.status",
          render: () => frames.mount(footerBadge(context, voice)),
        }),
      ]

      // Developer switch for unattended UI tests: start a call once a session is open.
      let autostart: ReturnType<typeof setInterval> | undefined
      if (process.env.GPT_LIVE_AUTOSTART) {
        autostart = setInterval(() => {
          if (!currentSession()) return
          clearInterval(autostart)
          autostart = undefined
          void start()
        }, 500)
      }

      return async () => {
        if (autostart) clearInterval(autostart)
        stopWatchingCall()
        for (const dispose of disposers) dispose()
        await voice.dispose()
        frames.dispose()
      }
    },
  }
}
