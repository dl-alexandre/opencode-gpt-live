import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

import { taskOutcomes } from "../src/server/bridge"

const prompts = path.join(import.meta.dir, "../src/server/prompts")

describe("capability wording", () => {
  test("voice prompts distinguish screen perception from delegated project access", () => {
    const files = [
      "gpt-live/03-thinking-and-acting.md",
      "voice-agent/04-boundaries.md",
      "voice-agent/05-how-to-work.md",
    ]
    for (const file of files) {
      const prompt = readFileSync(path.join(prompts, file), "utf8")
      expect(prompt).toContain("cannot see the user's screen")
      expect(prompt).toContain("coding session")
    }
    const work = readFileSync(path.join(prompts, "voice-agent/05-how-to-work.md"), "utf8")
    expect(work).toContain("Do not send a pure capability question")
  })
})

describe("delegated task outcomes", () => {
  test("a rejection before delivery is spoken exactly once", () => {
    const tasks = [{ id: "task_1", text: "Inspect the project", status: "queued" as const }]
    const spoken = taskOutcomes(tasks, "failed", "Model access is disabled")

    expect(spoken).toEqual(['The task "Inspect the project" failed: Model access is disabled'])
    expect(taskOutcomes(tasks, "failed", "Model access is disabled")).toEqual([])
    expect(spoken.join("\n")).not.toContain("looking into it")
  })

  test("a running failure is not announced again", () => {
    const tasks = [{ id: "task_1", text: "Inspect the project", status: "running" as const }]
    expect(taskOutcomes(tasks, "failed", "Model access is disabled")).toEqual([
      'The task "Inspect the project" failed: Model access is disabled',
    ])
    expect(taskOutcomes(tasks, "failed", "Model access is disabled")).toEqual([])
  })

  test("an event-stream disconnect reports every outstanding task once", () => {
    const tasks = [
      { id: "task_1", text: "Inspect the project", status: "queued" as const },
      { id: "task_2", text: "Run the tests", status: "done" as const },
    ]
    expect(taskOutcomes(tasks, "lost")).toEqual([
      'Lost track of the task "Inspect the project" when the OpenCode event stream disconnected. Its result is unknown.',
    ])
    expect(taskOutcomes(tasks, "lost")).toEqual([])
  })
})
