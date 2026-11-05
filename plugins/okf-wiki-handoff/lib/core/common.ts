// Shared by okf-wiki-handoff and okf-wiki-handoff-mod (through its `hooks/core` link), so it
// imports nothing but its own files: Node runs it in the plugin and the mod engine in the mod.

export const MARKER = '[okf-wiki-handoff]'
export const BUNDLE_NAME = 'okf-handoff'
export const HANDOFF_DIR = 'handoff'
export const HANDOFF_TAG = 'autosave-handoff'
export const HANDOFF_TYPE = 'Handoff'
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
export const DEFAULT_REMIND_TOKENS = 25_000

/** Names a project the way Claude Code names its folders under `projects/`. */
export function projectKey(projectRoot: string): string {
  return projectRoot.replace(/[^A-Za-z0-9]/g, '-')
}

/** The bundle folder that holds a project's handoff notes. */
export function handoffFolder(projectRoot: string): string {
  return `${HANDOFF_DIR}/${projectKey(projectRoot)}`
}

/** The note concept of a session in a project folder. */
export function noteConcept(folder: string, sessionId: string): string {
  return `${folder}/${sessionId.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`
}

/** A setting such as `25000`, `25k` or `2.5`, or `fallback` when it is not a positive number. */
export function parsePositive(raw: string | undefined, fallback: number): number {
  const match = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([kKmM]?)\s*$/.exec(raw ?? '')
  if (match === null) {
    return fallback
  }
  const unit = match[2]?.toLowerCase()
  const value = Number(match[1]) * (unit === 'k' ? 1_000 : unit === 'm' ? 1_000_000 : 1)

  return value > 0 ? value : fallback
}

export function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)} [clipped]`
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
