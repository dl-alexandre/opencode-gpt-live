/**
 * End-to-end check against the real GPT-Live service, without the TUI.
 *
 *   bun scripts/e2e-call.ts <project-dir> [--speak "text"] [--devices] [--seconds 45]
 *
 * Requires the plugin to be loaded for <project-dir> (for example via a symlink in
 * <project-dir>/.opencode/plugins/) and a ChatGPT sign-in in OpenCode. By default the
 * microphone is replaced by synthesized speech (macOS `say`) and the reply is written to
 * <project-dir>/gpt-live-reply.wav; --devices uses the real microphone and speaker.
 */
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { parseArgs } from "node:util"
import path from "node:path"
import { GptLive } from "../src/shared/rpc"
import { HelperProcess, findHelper } from "../src/tui/helper"

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    speak: { type: "string" },
    devices: { type: "boolean", default: false },
    seconds: { type: "string", default: "45" },
    session: { type: "string" },
  },
})

const directory = path.resolve(positionals[0] ?? process.cwd())
const seconds = Number(values.seconds)
const location = { directory }

const endpoint = await Service.discover()
if (!endpoint) throw new Error("OpenCode service is not running")
const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
const live = client.rpc(GptLive)

const status = await live.status({}, { location })
console.log("status", status)
if (!status.signedIn) process.exit(1)

const sessionID =
  values.session ?? (await client.session.create({ location, title: "GPT-Live e2e" } as never)).id
console.log("session", sessionID)

let input: unknown = undefined
let output: unknown = undefined
if (!values.devices) {
  const speech =
    values.speak ??
    "Hi there. Please ask OpenCode how many files are in this project and what they are called."
  const aiff = path.join(directory, "gpt-live-prompt.aiff")
  const wav = path.join(directory, "gpt-live-prompt.wav")
  await Bun.$`say -o ${aiff} ${speech}`.quiet()
  // Two seconds of lead-in silence so speech starts after the call is fully up.
  await Bun.$`ffmpeg -y -loglevel error -f lavfi -t 2 -i anullsrc=r=48000:cl=mono -i ${aiff} -filter_complex "[1:a]aresample=48000,aformat=channel_layouts=mono[s];[0:a][s]concat=n=2:v=0:a=1" -ar 48000 -ac 1 ${wav}`.quiet()
  input = { file: wav }
  output = { file: path.join(directory, "gpt-live-reply.wav") }
}

const abort = new AbortController()
const events: string[] = []
void (async () => {
  for await (const event of client.event.subscribe({ signal: abort.signal } as never)) {
    const type = (event as { type: string }).type
    const data = (event as { data?: Record<string, unknown> }).data
    if (type.startsWith("rpc.gptlive.")) {
      const line = `${type.slice(12)} ${JSON.stringify(data)}`
      events.push(line)
      console.log("event", line)
    } else if (data?.sessionID === sessionID && /execution|inbox.delivered|tool.input.started/.test(type)) {
      console.log("session", type, type.includes("tool") ? data.name : "")
    }
  }
})().catch(() => {})

const helper = new HelperProcess(findHelper(), {
  onEvent: (event) => {
    if (event.type === "levels") {
      if ((event.speaker as number) > 0.05) process.stdout.write("♪")
      else if ((event.mic as number) > 0.05) process.stdout.write("·")
      return
    }
    if (event.type !== "offer") console.log("helper", JSON.stringify(event))
  },
})

const offer = await helper.start({ input, output })
console.log("offer ready", offer.length, "bytes")
const call = await live.start({ sessionID, sdp: offer }, { location })
console.log("call", call.callID, call.model, call.voice, "voice session", call.voiceSessionID)
await helper.answer(call.sdp)
console.log("webrtc connected")

await Bun.sleep(seconds * 1000)
console.log("\nstopping")
await live.stop({ callID: call.callID }, { location })
await helper.close()
abort.abort()
console.log(`\n${events.length} plugin events`)
process.exit(0)
