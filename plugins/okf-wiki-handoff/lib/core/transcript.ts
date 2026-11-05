import { clip, isRecord } from './common.ts'

const TOOL_INPUT_CHARS = 2_000
const TOOL_RESULT_CHARS = 4_000

/** How much of a tool call's input and result a rendered entry keeps; a search matches against all of it. */
export type Detail = 'brief' | 'full'

function cut(text: string, limit: number, detail: Detail): string {
  return detail === 'full' ? text : clip(text, limit)
}
// Codex records its instruction files and environment as user messages.
const CODEX_INJECTED_PREFIXES = ['# AGENTS.md instructions', '<environment_context>', '<user_instructions>']

function textOf(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }

  return content
    .map(block => (typeof block === 'string' ? block : isRecord(block) && typeof block.text === 'string' ? block.text : ''))
    .filter(text => text !== '')
    .join('\n')
}

function renderClaudeBlock(block: unknown, detail: Detail): string {
  if (typeof block === 'string') {
    return block
  }
  if (!isRecord(block)) {
    return ''
  }
  if (block.type === 'text') {
    return typeof block.text === 'string' ? block.text : ''
  }
  if (block.type === 'tool_use') {
    const name = typeof block.name === 'string' ? block.name : 'tool'

    return `[tool_use ${name}] ${cut(JSON.stringify(block.input ?? {}), TOOL_INPUT_CHARS, detail)}`
  }
  if (block.type === 'tool_result') {
    const label = block.is_error === true ? 'tool_result error' : 'tool_result'

    return `[${label}] ${cut(textOf(block.content), TOOL_RESULT_CHARS, detail)}`
  }

  return ''
}

/** One transcript JSONL line as a readable message, from Claude Code or Codex, or `undefined` for none. */
export function renderEntry(line: string, detail: Detail = 'brief'): string | undefined {
  let entry: unknown
  try {
    entry = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!isRecord(entry)) {
    return undefined
  }
  if ((entry.type === 'user' || entry.type === 'assistant') && isRecord(entry.message)) {
    const content = entry.message.content
    const text = (Array.isArray(content) ? content : [content])
      .map(block => renderClaudeBlock(block, detail))
      .filter(part => part !== '')
      .join('\n')

    return text === '' ? undefined : `${entry.type}: ${text}`
  }
  const payload = entry.payload
  if (entry.type !== 'response_item' || !isRecord(payload)) {
    return undefined
  }
  if (payload.type === 'message' && (payload.role === 'user' || payload.role === 'assistant')) {
    const text = textOf(payload.content)
    if (text === '' || CODEX_INJECTED_PREFIXES.some(prefix => text.trimStart().startsWith(prefix))) {
      return undefined
    }

    return `${payload.role}: ${text}`
  }
  if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
    const raw = payload.arguments ?? payload.input ?? ''
    const input = typeof raw === 'string' ? raw : JSON.stringify(raw)
    const name = typeof payload.name === 'string' && payload.name !== '' ? payload.name : 'tool'

    return `assistant: [tool_use ${name}] ${cut(input, TOOL_INPUT_CHARS, detail)}`
  }
  if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
    let output = payload.output
    if (isRecord(output)) {
      output = output.content ?? output
    }
    const text = typeof output === 'string' ? output : textOf(output) || JSON.stringify(output ?? null)

    return `tool: [tool_result] ${cut(text, TOOL_RESULT_CHARS, detail)}`
  }

  return undefined
}

/**
 * Renders transcript JSONL lines as readable messages, with each of `marks`
 * before its line, stopping at a whole entry once `maxChars` is reached so the
 * reader can continue from `nextLine`.
 */
export function renderEntries(
  lines: readonly string[],
  firstLine: number,
  maxChars: number,
  marks: ReadonlyMap<number, string> = new Map(),
): { text: string; nextLine: number | undefined } {
  const parts: string[] = []
  let used = 0
  for (const [offset, line] of lines.entries()) {
    const number = firstLine + offset
    const mark = marks.get(number)
    const rendered = renderEntry(line)
    if (rendered === undefined && mark === undefined) {
      continue
    }
    const part = [mark, rendered === undefined ? undefined : `L${number} ${rendered}`]
      .filter(piece => piece !== undefined)
      .join('\n\n')
    if (used > 0 && used + part.length > maxChars) {
      return { text: parts.join('\n\n'), nextLine: number }
    }
    parts.push(clip(part, maxChars))
    used += part.length
  }

  return { text: parts.join('\n\n'), nextLine: undefined }
}
