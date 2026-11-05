// Shared by okf-wiki-autosave and okf-wiki-autosave-mod (through its `hooks/core` link), so it
// imports nothing but its own files: Node runs it in the plugin and the mod engine in the mod.
//
// Lengths and cuts count code points, and JSON is written the way Python's `json.dumps` writes
// it, so limits, receipts and planner payloads match what the worklogs were built with.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function length(text: string): number {
  let count = 0
  for (const _ of text) {
    count += 1
  }

  return count
}

/** The first `limit` code points of `text`. */
export function head(text: string, limit: number): string {
  return length(text) <= limit ? text : Array.from(text).slice(0, limit).join('')
}

/** The last `limit` code points of `text`. */
export function tail(text: string, limit: number): string {
  return length(text) <= limit ? text : Array.from(text).slice(-limit).join('')
}

export function utf8Length(text: string): number {
  let bytes = 0
  for (const character of text) {
    const point = character.codePointAt(0) ?? 0
    bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4
  }

  return bytes
}

/**
 * JSON as Python's `json.dumps(value, ensure_ascii=False)` writes it: `", "`
 * and `": "` between items unless `compact`, keys sorted when `sortKeys`.
 */
export function pythonJson(value: unknown, options: { compact?: boolean; sortKeys?: boolean } = {}): string {
  const item = options.compact === true ? ',' : ', '
  const pair = options.compact === true ? ':' : ': '
  const write = (current: unknown): string => {
    if (Array.isArray(current)) {
      return `[${current.map(write).join(item)}]`
    }
    if (isRecord(current)) {
      const keys = Object.keys(current).filter(key => current[key] !== undefined)
      if (options.sortKeys === true) {
        keys.sort()
      }

      return `{${keys.map(key => `${JSON.stringify(key)}${pair}${write(current[key])}`).join(item)}}`
    }

    return JSON.stringify(current ?? null)
  }

  return write(value)
}

/** How Python's `repr` shows a value in an error message. */
export function pythonRepr(value: unknown): string {
  if (value === undefined || value === null) {
    return 'None'
  }
  if (typeof value === 'string') {
    return value.includes("'") && !value.includes('"') ? `"${value}"` : `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
  }
  if (typeof value === 'boolean') {
    return value ? 'True' : 'False'
  }

  return JSON.stringify(value)
}
