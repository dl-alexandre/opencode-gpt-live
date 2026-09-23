/**
 * Loads the system prompts. Each built-in prompt is a folder of Markdown sections in
 * src/server/prompts/<name>/, joined in file-name order. Prompts are read at the start of
 * every call, so edits apply to the next call without restarting OpenCode.
 *
 * Users can replace a prompt with their own file or folder (the `prompts` option) and append
 * to it (`instructions`, `voiceAgentInstructions`).
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

export type PromptName = "gpt-live" | "voice-agent"

export const BUILT_IN_PROMPTS = fileURLToPath(new URL("./prompts/", import.meta.url))

const LABELS: Record<PromptName, string> = { "gpt-live": "GPT-Live", "voice-agent": "voice agent" }

export interface PromptInput {
  /** Path to a replacement prompt: a Markdown file, or a folder of sections. */
  override?: string
  /** Text appended as additional instructions from the user. */
  extra?: string
  /** Relative override paths resolve against this directory (the project). */
  directory: string
  /** Values for {{placeholders}}. */
  variables: Record<string, string>
}

export interface LoadedPrompt {
  text: string
  /** Problems worth telling the user about, e.g. an override that could not be read. */
  notices: string[]
}

/** Reads a prompt from a Markdown file, or from a folder of Markdown sections in name order. */
export function readPromptSource(source: string): string {
  const sections = statSync(source).isDirectory()
    ? readdirSync(source)
        .filter((name) => name.toLowerCase().endsWith(".md"))
        .toSorted()
        .map((name) => readFileSync(path.join(source, name), "utf8"))
    : [readFileSync(source, "utf8")]
  const text = sections
    .map((section) => section.replace(/<!--[\s\S]*?-->/g, "").trim())
    .filter(Boolean)
    .join("\n\n")
  if (!text) throw new Error("it is empty")
  return text
}

/** Fills {{name}} placeholders; unknown ones are left as written. */
export function renderPrompt(template: string, variables: Record<string, string>) {
  return template.replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (match, name: string) => variables[name] ?? match)
}

export function resolvePromptPath(value: string, directory: string) {
  const expanded = value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(1)) : value
  return path.resolve(directory, expanded)
}

export function loadPrompt(name: PromptName, input: PromptInput): LoadedPrompt {
  const notices: string[] = []
  let template: string | undefined
  if (input.override?.trim()) {
    const source = resolvePromptPath(input.override.trim(), input.directory)
    try {
      template = readPromptSource(source)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      notices.push(`Could not use your ${LABELS[name]} prompt at ${source} (${reason}); using the built-in one.`)
    }
  }
  template ??= readPromptSource(path.join(BUILT_IN_PROMPTS, name))
  let text = renderPrompt(template, input.variables)
  const extra = input.extra?.trim()
  if (extra) text = `${text}\n\nAdditional instructions from the user:\n${extra}`
  return { text, notices }
}
