import type { Plugin } from "@opencode/plugin"

import type { TaskStatus } from "../shared/rpc"
import { clip, speakable } from "./context"
import type { LiveEvent, Sideband } from "./live"
import type { CallLog } from "./log"
import {
  acceptCatalog,
  bindPermissionReply,
  resolveStop,
  selectCodingTarget,
  targetLabel,
  type BoundPermission,
  type CodingTarget,
} from "./routing"

type Context = Plugin.Context

export interface BridgeEvents {
  transcript(role: "user" | "assistant", text: string, final: boolean): void
  task(taskID: string, text: string, status: TaskStatus, detail?: string): void
  activity(scope: "voice" | "main", busy: boolean, label?: string): void
  closed(reason: string): void
  error(message: string): void
  /** The user asked (by voice) to hang up. */
  end(reason: string): void
  /** A finished conversation turn, for persistence across calls. */
  turn?(role: "user" | "assistant", text: string): void
  /** The selected coding session changed. Terminal focus does not emit this. */
  target?(target: CodingTarget): void
}

interface Task {
  id: string
  text: string
  sessionID: string
  inboxID?: string
  status: TaskStatus
}

export type TaskOutcome = "done" | "failed" | "cancelled" | "lost"

export interface SpokenOutcome {
  id: string
  status: TaskStatus
  detail?: string
  spoken?: string
}

/** One outcome per still-open task. Pure: the caller applies the status. Queued tasks are included only when asked. */
export function taskOutcomes(
  tasks: readonly Task[],
  outcome: TaskOutcome,
  options: { error?: string; result?: string; cancelledByUser?: boolean; includeQueued?: boolean } = {},
): SpokenOutcome[] {
  const open = tasks.filter((task) => task.status === "running" || (options.includeQueued && task.status === "queued"))
  return open.map((task) => {
    const status: TaskStatus = outcome === "done" ? "done" : outcome === "cancelled" ? "cancelled" : "failed"
    const label = clip(task.text, 120)
    if (outcome === "done") {
      return {
        id: task.id,
        status,
        spoken: options.result
          ? `Finished the task "${label}". Outcome: ${options.result}`
          : `Finished the task "${label}".`,
      }
    }
    if (outcome === "failed") {
      const detail = clip(options.error ?? "unknown error", 300)
      return { id: task.id, status, detail, spoken: `The task "${label}" failed: ${detail}` }
    }
    if (outcome === "lost") {
      return {
        id: task.id,
        status,
        detail: "event stream lost",
        spoken: `Lost track of the task "${label}" when the OpenCode event stream disconnected. Its result is unknown.`,
      }
    }
    return {
      id: task.id,
      status,
      spoken: options.cancelledByUser ? undefined : `Work on "${label}" was stopped.`,
    }
  })
}

const TOOL_LABELS: Record<string, string> = {
  read: "reading files",
  write: "writing a file",
  edit: "editing code",
  apply_patch: "editing code",
  bash: "running a command",
  shell: "running a command",
  grep: "searching the code",
  glob: "looking for files",
  list: "browsing files",
  webfetch: "reading a web page",
  websearch: "searching the web",
  task: "working with a subagent",
  subagent: "working with a subagent",
  todowrite: "updating its plan",
  skill: "loading a skill",
  patch: "editing code",
  gptlive_targets: "listing coding sessions",
  gptlive_select_target: "switching the coding session",
  gptlive_main_send: "handing work to OpenCode",
  gptlive_main_status: "checking on OpenCode",
  gptlive_main_read: "reading the session",
  gptlive_main_stop: "stopping OpenCode",
  gptlive_main_permissions: "checking permissions",
  gptlive_main_permission_reply: "answering a permission",
  gptlive_end_call: "ending the call",
}

export function toolLabel(name: string) {
  const key = name.toLowerCase()
  if (TOOL_LABELS[key]) return TOOL_LABELS[key]
  const suffix = key.split(/[_.]/).pop() ?? key
  return TOOL_LABELS[suffix] ?? `using ${name.replaceAll("_", " ")}`
}

/**
 * Connects one GPT-Live call to two OpenCode sessions:
 * - the voice session, which receives everything GPT-Live delegates and whose agent
 *   answers conversational questions or hands real work over with the plugin tools;
 * - the main session the call was started from, which only ever receives explicit tasks.
 */
export class Bridge {
  private readonly tasks = new Map<string, Task>()
  private readonly voiceInbox = new Map<string, string>()
  private readonly abort = new AbortController()
  private currentDelegation: string | undefined
  private voiceText = ""
  private voiceDelegated = false
  private mainBusy = false
  private mainLabel: string | undefined
  private mainText = ""
  private cancelRequested = false
  private closed = false
  private ending = false
  private taskCounter = 0
  /** Finished conversation turns since the last hand-off to the voice agent. */
  private turns: { role: "user" | "assistant"; text: string }[] = []
  /** Coding-session updates the voice agent has not seen yet. */
  private updates: string[] = []
  private introduced = false
  private streamLost = false
  private currentTarget: CodingTarget
  private catalog: CodingTarget[]
  private targetAvailable = true
  private readonly pendingPermissions = new Map<string, BoundPermission>()
  private readonly sessionText = new Map<string, string>()
  private readonly runs = new Map<string, { busy: boolean; label?: string; text: string; cancelRequested: boolean }>()
  private pendingSwitch: { sessionID: string; turn: number } | undefined
  private userTurns = 0

  constructor(
    private readonly ctx: Context,
    mainSessionID: string,
    readonly voiceSessionID: string,
    private readonly sideband: Sideband,
    private readonly events: BridgeEvents,
    private readonly log?: CallLog,
    private readonly call = 1,
    target?: CodingTarget,
  ) {
    this.currentTarget = target ?? { sessionID: mainSessionID, title: "this session", directory: "" }
    this.catalog = [this.currentTarget]
    void this.watchSessions()
  }

  get mainSessionID() {
    return this.currentTarget.sessionID
  }

  get target() {
    return this.currentTarget
  }

  handle(event: LiveEvent) {
    switch (event.kind) {
      case "transcript":
        this.events.transcript(event.role, event.text, event.final)
        if (event.final && event.text.trim()) {
          if (event.role === "user") this.userTurns += 1
          this.turns.push({ role: event.role, text: event.text.trim() })
          if (this.turns.length > 40) this.turns = this.turns.slice(-40)
          this.log?.write({ type: "turn", role: event.role, text: event.text.trim() })
          this.events.turn?.(event.role, event.text.trim())
        }
        return
      case "delegation":
        void this.toVoice(event.id, event.text).catch((error) =>
          this.events.error(`Could not reach the voice agent: ${String(error)}`),
        )
        return
      case "closed":
        this.events.closed(event.reason ?? "closed")
        return
      case "error":
        this.events.error(event.message)
        return
    }
  }

  private async toVoice(delegationID: string, raw: string) {
    const request = raw.trim()
    if (!request) return
    this.log?.write({ type: "handoff", delegationID, request, turns: this.turns, updates: this.updates })
    const text = handoff(request, this.turns, this.updates, this.introduced ? undefined : this.call)
    this.introduced = true
    this.turns = []
    this.updates = []
    const entry = await this.ctx.session.prompt({
      sessionID: this.voiceSessionID as never,
      text,
      delivery: "queue",
      metadata: { gptLive: { delegationID } },
    })
    const inboxID = (entry as { id?: string }).id
    if (inboxID) this.voiceInbox.set(inboxID, delegationID)
  }

  /** Tool: send a task or message to the main session. */
  async send(raw: string, delivery: "queue" | "steer" = "queue"): Promise<string> {
    const text = raw.trim()
    if (!text) throw new Error("text is empty; write the brief you want to send")
    if (this.streamLost)
      throw new Error("The OpenCode event stream is gone, so this call can no longer report a result.")
    if (!this.targetAvailable) {
      throw new Error(
        `The coding session "${this.currentTarget.title}" is gone. Choose another target before sending work.`,
      )
    }
    this.log?.write({ type: "task", delivery, text, sessionID: this.mainSessionID })
    const id = `task_${++this.taskCounter}`
    const record: Task = { id, text, sessionID: this.mainSessionID, status: "queued" }
    this.tasks.set(id, record)
    this.events.task(id, text, "queued")
    try {
      const entry = await this.ctx.session.prompt({
        sessionID: this.mainSessionID as never,
        text,
        delivery,
        metadata: { gptLive: { voiceSessionID: this.voiceSessionID, taskID: id } },
      })
      record.inboxID = (entry as { id?: string }).id
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.failUnaccepted(record, reason)
      return `Failed before the coding session started: ${clip(reason, 300)}`
    }
    if (delivery === "steer" && this.mainBusy)
      return "Delivered to the main session's current work as a steering message. The outcome will be announced when it finishes."
    return this.mainBusy
      ? "Queued in the main session. It is busy with earlier work, so this starts next. The result will be announced when it is done."
      : "Sent to the main session, which has started on it. The result will be announced when it is done."
  }

  /** Tool: recent main-session conversation, including which tools were used. */
  async read(limit = 8): Promise<string> {
    const messages = (await this.ctx.session.context({ sessionID: this.mainSessionID as never })) as readonly Record<
      string,
      unknown
    >[]
    const lines: string[] = []
    for (const message of messages) {
      if (message.type === "user" && typeof message.text === "string") {
        lines.push(`User: ${clip(message.text.trim(), 500)}`)
      } else if (message.type === "assistant" && Array.isArray(message.content)) {
        const parts = message.content as Record<string, unknown>[]
        const tools = parts.filter((part) => part.type === "tool").map((part) => String(part.name))
        const text = parts
          .filter((part) => part.type === "text" && typeof part.text === "string")
          .map((part) => part.text as string)
          .join("\n")
          .trim()
        if (tools.length) lines.push(`Agent used tools: ${[...new Set(tools)].join(", ")}`)
        if (text) lines.push(`Agent: ${clip(speakable(text, 1_500), 1_500)}`)
      }
    }
    const recent = lines.slice(-Math.max(1, Math.min(limit, 30)) * 2)
    return recent.length ? recent.join("\n") : "The main session has no messages yet."
  }

  /** Tool: sessions in this project that the call can address. */
  listTargets(): string {
    const lines = this.catalog.map((target) => {
      const selected = target.sessionID === this.currentTarget.sessionID ? "selected" : "available"
      const gone = selected === "selected" && !this.targetAvailable ? ", unavailable" : ""
      return `- ${target.sessionID}: ${targetLabel(target)} (${selected}${gone})`
    })
    return [`Coding target: ${targetLabel(this.currentTarget)}.`, ...lines].join("\n")
  }

  /** Replace the same-project catalog published by the terminal. Does not follow focus. */
  replaceCatalog(offered: readonly CodingTarget[]) {
    const eligible = offered.filter((item) => item.sessionID !== this.voiceSessionID)
    const accepted = acceptCatalog(this.currentTarget, eligible)
    this.catalog = accepted.catalog
    this.targetAvailable = accepted.currentAvailable
    if (eligible.length > 0) this.dropGoneTasks(new Set(eligible.map((item) => item.sessionID)))
    return this.catalog.filter((item) => this.targetAvailable || item.sessionID !== this.currentTarget.sessionID).length
  }

  /** Tool: switch the session that receives the next task. In-flight work stays put. */
  selectTarget(sessionID: string, confirmed = false): string {
    if (sessionID === this.voiceSessionID) return "The voice session cannot be a coding target. No target was changed."
    if (!confirmed) {
      this.pendingSwitch = { sessionID, turn: this.userTurns }
      const preview = selectCodingTarget({
        current: this.currentTarget,
        catalog: this.catalog,
        sessionID,
        confirmed: false,
      })
      return preview.ok ? preview.value.announcement : preview.reason
    }
    if (
      !this.pendingSwitch ||
      this.pendingSwitch.sessionID !== sessionID ||
      this.userTurns <= this.pendingSwitch.turn
    ) {
      return "That switch is not confirmed. Ask the user, then confirm only after they agree."
    }
    const selected = selectCodingTarget({
      current: this.currentTarget,
      catalog: this.catalog,
      sessionID,
      confirmed: true,
    })
    if (!selected.ok) return selected.reason
    const previous = this.currentTarget
    this.currentTarget = selected.value.target
    this.pendingSwitch = undefined
    if (previous.sessionID !== this.currentTarget.sessionID) {
      this.targetAvailable = true
      this.showTargetActivity()
      this.events.target?.(this.currentTarget)
      this.notifyVoice(selected.value.announcement)
    }
    return `Target is ${this.currentTarget.title}. The user has already been told, so do not repeat the announcement.`
  }

  /** Tool: pending permission requests, each bound to the session that asked. */
  async permissions(): Promise<string> {
    const requests = await this.collectPermissions()
    if (!requests.length) return "The coding sessions have no pending permission requests."
    return requests
      .map(
        (request) =>
          `- id ${request.id}: ${request.title} wants to ${request.action} ${(request.resources ?? []).join(", ")}${request.message ? ` (${request.message})` : ""}`,
      )
      .join("\n")
  }

  /** Tool: answer a pending permission in the session that asked for it. */
  async replyPermission(requestID: string, decision: "once" | "always" | "reject", message?: string) {
    const bound = bindPermissionReply(await this.collectPermissions(), requestID)
    if (!bound.ok) return bound.reason
    await this.ctx.permission.reply({
      sessionID: bound.value.sessionID as never,
      requestID: requestID as never,
      decision,
      ...(message ? { message } : {}),
    })
    this.pendingPermissions.delete(requestID)
    const verb = decision === "reject" ? "Rejected" : `Allowed (${decision})`
    return `${verb} the request in ${bound.value.title}.`
  }

  /** Tool: describe what the main session is doing. */
  status(): string {
    const run = this.run(this.mainSessionID)
    const own = [...this.tasks.values()].filter((task) => task.sessionID === this.mainSessionID)
    const queued = own.filter((task) => task.status === "queued")
    const running = own.find((task) => task.status === "running")
    const elsewhere = [...this.tasks.values()].filter(
      (task) => task.sessionID !== this.mainSessionID && (task.status === "queued" || task.status === "running"),
    )
    const lines = [
      run.busy
        ? `${this.currentTarget.title} is working${running ? ` on: ${clip(running.text, 200)}` : " on something the user typed"}.`
        : `${this.currentTarget.title} is idle.`,
      run.busy && run.label ? `Right now it is ${run.label}.` : undefined,
      queued.length ? `Queued tasks: ${queued.map((task) => clip(task.text, 80)).join("; ")}.` : undefined,
      elsewhere.length
        ? `Other sessions still have work: ${elsewhere.map((task) => `${this.titleFor(task.sessionID)}: ${clip(task.text, 60)}`).join("; ")}.`
        : undefined,
      !run.busy && run.text ? `Its last reply was: ${clip(speakable(run.text), 600)}` : undefined,
    ]
    return lines.filter(Boolean).join("\n")
  }

  /** Tool: interrupt one unambiguous coding session, or the session the user named. */
  async cancel(sessionID?: string): Promise<string> {
    const busy = [...this.runs.entries()]
      .filter(([, run]) => run.busy)
      .map(([id]) => ({ sessionID: id, title: this.titleFor(id) }))
    const resolved =
      busy.length === 0
        ? { ok: true as const, value: { sessionID: sessionID ?? this.mainSessionID } }
        : resolveStop(busy, sessionID)
    if (!resolved.ok) return resolved.reason
    this.run(resolved.value.sessionID).cancelRequested = true
    this.cancelRequested = true
    const result = await this.ctx.session
      .interrupt({ sessionID: resolved.value.sessionID as never, resume: false })
      .catch(() => undefined)
    for (const task of this.tasks.values()) {
      if (task.sessionID !== resolved.value.sessionID) continue
      if (task.status === "queued" || task.status === "running") this.setStatus(task, "cancelled")
    }
    return (result as { interrupted?: boolean } | undefined)?.interrupted
      ? `Stopped work in ${this.titleFor(resolved.value.sessionID)}.`
      : `${this.titleFor(resolved.value.sessionID)} was not running anything.`
  }

  private titleFor(sessionID: string) {
    return this.catalog.find((target) => target.sessionID === sessionID)?.title ?? sessionID
  }

  private setStatus(task: Task, status: TaskStatus, detail?: string) {
    task.status = status
    this.events.task(task.id, task.text, status, detail)
  }

  private async watchSessions() {
    const signal = this.abort.signal
    try {
      for await (const event of this.ctx.event.subscribe({ signal })) {
        const data = (event as { data?: Record<string, unknown> }).data
        if (!data) continue
        if (signal.aborted) return
        if (data.sessionID === this.voiceSessionID) this.onVoiceEvent(event.type, data)
        else if (this.tracks(String(data.sessionID))) this.onMainEvent(event.type, data)
      }
      if (!signal.aborted) this.lostEvents("The OpenCode event stream ended")
    } catch (error) {
      if (!signal.aborted) this.lostEvents(error instanceof Error ? error.message : String(error))
    }
  }

  /** Outstanding tasks can no longer receive their terminal event, so say so once and end the call. */
  private lostEvents(reason: string) {
    if (this.streamLost || this.closed) return
    this.streamLost = true
    this.events.error(`Lost the OpenCode event stream: ${reason}`)
    this.applyOutcomes(taskOutcomes([...this.tasks.values()], "lost", { includeQueued: true }))
    this.events.end(`Lost the OpenCode event stream: ${reason}`)
  }

  private onVoiceEvent(type: string, data: Record<string, unknown>) {
    switch (type) {
      case "session.inbox.delivered": {
        const delegation = this.voiceInbox.get(String(data.inboxID))
        if (delegation) {
          this.voiceInbox.delete(String(data.inboxID))
          this.currentDelegation = delegation
        }
        return
      }
      case "session.execution.started":
        this.voiceText = ""
        this.voiceDelegated = false
        this.events.activity("voice", true, "thinking")
        return
      case "session.tool.input.started":
        if (typeof data.name !== "string") return
        if (data.name === "gptlive_main_send") this.voiceDelegated = true
        this.events.activity("voice", true, toolLabel(data.name))
        return
      case "session.text.ended":
        if (typeof data.text === "string" && data.text.trim()) this.voiceText = data.text
        return
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted": {
        this.events.activity("voice", false)
        const text = speakable(this.voiceText, 1_200)
        const failed = type === "session.execution.failed"
        const message = failed
          ? `The voice agent hit an error: ${clip((data.error as { message?: string })?.message ?? "unknown", 200)}`
          : text
        // After handing work off, GPT-Live has already acknowledged; the result is spoken later.
        const channel = (this.voiceDelegated || !this.currentDelegation) && !failed ? "commentary" : "speakable"
        if (message) this.log?.write({ type: "voice-reply", channel, text: message })
        if (message) this.sideband.append(message, channel, this.currentDelegation)
        this.currentDelegation = undefined
        this.voiceText = ""
        return
      }
    }
  }

  private onMainEvent(type: string, data: Record<string, unknown>) {
    switch (type) {
      case "permission.asked": {
        const sessionID = String(data.sessionID)
        const title = this.titleFor(sessionID)
        const requestID = String(data.id)
        this.pendingPermissions.set(requestID, { id: requestID, sessionID, title })
        const resources = Array.isArray(data.resources) ? data.resources.join(", ") : ""
        const spoken = `${title} needs permission to ${String(data.action ?? "continue")}${resources ? ` ${clip(resources, 160)}` : ""}. Ask whether to allow it once, always, or reject it.`
        this.sideband.append(spoken, "speakable")
        this.notifyVoice(`${spoken} Request id: ${requestID}.`)
        return
      }
      case "permission.replied":
        this.pendingPermissions.delete(String(data.id))
        return
      case "session.inbox.delivered": {
        const task = [...this.tasks.values()].find((item) => item.inboxID === data.inboxID)
        if (task && task.status === "queued") this.setStatus(task, "running")
        return
      }
      case "session.execution.started": {
        const sessionID = String(data.sessionID)
        this.sessionText.delete(sessionID)
        this.promoteQueued(sessionID)
        const run = this.run(sessionID)
        run.busy = true
        run.label = "thinking"
        run.text = ""
        run.cancelRequested = false
        if (sessionID === this.mainSessionID) this.showTargetActivity()
        return
      }
      case "session.tool.input.started":
        if (typeof data.name !== "string") return
        this.run(String(data.sessionID)).label = toolLabel(data.name)
        if (String(data.sessionID) === this.mainSessionID) this.showTargetActivity()
        return
      case "session.text.ended":
        if (typeof data.text === "string" && data.text.trim()) {
          this.sessionText.set(String(data.sessionID), data.text)
          this.run(String(data.sessionID)).text = data.text
        }
        return
      case "session.execution.succeeded":
        this.finishMain(String(data.sessionID), "done")
        return
      case "session.execution.failed":
        this.finishMain(String(data.sessionID), "failed", (data.error as { message?: string } | undefined)?.message)
        return
      case "session.execution.interrupted":
        this.finishMain(String(data.sessionID), "cancelled")
        return
    }
  }

  /** A task rejected before OpenCode delivered it still needs one spoken failure. */
  private failUnaccepted(task: Task, error: string) {
    if (task.status !== "queued") return
    this.setStatus(task, "failed", error)
    this.announce(`The task "${clip(task.text, 120)}" failed before it started: ${clip(error, 300)}`)
  }

  /** Promote the next queued task for this session only when that session has nothing running. */
  private promoteQueued(sessionID: string) {
    const tasks = [...this.tasks.values()].filter((task) => task.sessionID === sessionID)
    if (tasks.some((task) => task.status === "running")) return
    const next = tasks.find((task) => task.status === "queued")
    if (next) this.setStatus(next, "running")
  }

  private tracks(sessionID: string) {
    if (sessionID === this.mainSessionID) return true
    if ([...this.pendingPermissions.values()].some((request) => request.sessionID === sessionID)) return true
    return [...this.tasks.values()].some(
      (task) => task.sessionID === sessionID && (task.status === "queued" || task.status === "running"),
    )
  }

  private finishMain(sessionID: string, outcome: "done" | "failed" | "cancelled", error?: string) {
    const run = this.run(sessionID)
    run.busy = false
    run.label = undefined
    if (sessionID === this.mainSessionID) this.showTargetActivity()
    const title = this.titleFor(sessionID)
    const outcomes = taskOutcomes(
      [...this.tasks.values()].filter((task) => task.sessionID === sessionID),
      outcome,
      {
        error,
        result: speakable(this.sessionText.get(sessionID) ?? run.text),
        cancelledByUser: run.cancelRequested,
      },
    )
    for (const item of outcomes) if (item.spoken) item.spoken = `${title}: ${item.spoken}`
    this.applyOutcomes(outcomes)
  }

  private run(sessionID: string) {
    let run = this.runs.get(sessionID)
    if (!run) {
      run = { busy: false, text: "", cancelRequested: false }
      this.runs.set(sessionID, run)
    }
    return run
  }

  private showTargetActivity() {
    const run = this.run(this.mainSessionID)
    this.mainBusy = run.busy
    this.mainLabel = run.label
    this.mainText = run.text
    this.events.activity("main", run.busy, run.busy ? run.label : undefined)
  }

  private async collectPermissions() {
    const sessionIDs = new Set<string>([
      this.mainSessionID,
      ...[...this.tasks.values()]
        .filter((task) => task.status === "queued" || task.status === "running")
        .map((task) => task.sessionID),
    ])
    const requests: BoundPermission[] = []
    const listedBySession = await Promise.all(
      [...sessionIDs].map(async (sessionID) => ({
        sessionID,
        listed: (await this.ctx.permission.list({ sessionID: sessionID as never }).catch(() => [])) as readonly {
          id: string
          action?: string
          resources?: readonly string[]
          message?: string
        }[],
      })),
    )
    for (const { sessionID, listed } of listedBySession) {
      for (const request of listed) {
        requests.push({
          id: request.id,
          sessionID,
          title: this.titleFor(sessionID),
          action: request.action ?? "continue",
          resources: request.resources ?? [],
          message: request.message,
        })
      }
    }
    this.pendingPermissions.clear()
    for (const request of requests) this.pendingPermissions.set(request.id, request)
    return requests
  }

  private dropGoneTasks(present: ReadonlySet<string>) {
    for (const task of this.tasks.values()) {
      if (task.status !== "queued" && task.status !== "running") continue
      if (present.has(task.sessionID)) continue
      this.setStatus(task, "failed", "session gone")
      this.run(task.sessionID).busy = false
      this.announce(`${this.titleFor(task.sessionID)} is gone, so work on "${clip(task.text, 80)}" will not finish.`)
    }
  }

  private applyOutcomes(outcomes: readonly SpokenOutcome[]) {
    for (const outcome of outcomes) {
      const task = this.tasks.get(outcome.id)
      if (!task || (task.status !== "queued" && task.status !== "running")) continue
      this.setStatus(task, outcome.status, outcome.detail)
      if (outcome.spoken) this.announce(outcome.spoken)
    }
  }

  /** Speak an outcome once and keep it for the voice agent's next hand-off. */
  private announce(spoken: string) {
    this.sideband.append(spoken, "speakable")
    this.notifyVoice(spoken)
  }

  /** Queue a coding-session update for the voice agent's next hand-off (no extra turn). */
  private notifyVoice(text: string) {
    this.log?.write({ type: "update", text })
    this.updates.push(text)
    if (this.updates.length > 10) this.updates = this.updates.slice(-10)
  }

  /** Tool: hang up after the goodbye has been spoken. */
  endCall(): string {
    if (this.ending) return "The call is already ending."
    this.ending = true
    this.log?.write({ type: "end-requested" })
    setTimeout(() => this.events.end("Ended by voice"), 4_500)
    return "The call ends in a few seconds. Reply with a very short goodbye and nothing else."
  }

  /** Lets the user type a message straight to the voice layer. */
  say(text: string) {
    this.sideband.append(`The user typed: ${text}`, "speakable")
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.abort.abort()
    this.sideband.close()
  }
}

function escape(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

/**
 * Builds the message the voice agent receives for one hand-off: the conversation since
 * the previous hand-off (turns GPT-Live answered itself included), coding-session updates
 * it has not seen, and the request as the voice model understood it.
 */
export function handoff(
  request: string,
  turns: readonly { role: "user" | "assistant"; text: string }[],
  updates: readonly string[],
  call?: number,
) {
  const parts: string[] = []
  if (call !== undefined) {
    parts.push(
      call > 1
        ? `<call_started number="${call}">A new voice call started. Earlier calls in this session are above; the user may refer back to them.</call_started>`
        : `<call_started number="1">The first voice call in this session started.</call_started>`,
    )
  }
  if (turns.length) {
    const lines = turns.map((turn) => `${turn.role === "user" ? "user" : "you"}: ${escape(clip(turn.text, 1_200))}`)
    parts.push(`<conversation_since_last_message>\n${lines.join("\n")}\n</conversation_since_last_message>`)
  }
  if (updates.length) {
    parts.push(
      `<coding_session_updates>\n${updates.map((update) => `- ${escape(update)}`).join("\n")}\n</coding_session_updates>`,
    )
  }
  parts.push(`<request>${escape(request)}</request>`)
  return parts.join("\n")
}
