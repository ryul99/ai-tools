import { clip, isRecord } from './common.ts'
import { segmentsOf } from './notes.ts'
import type { Store } from './notes.ts'

export const RECALL_CHUNK_LINES = 200
export const RECALL_MAX_CHARS = 30_000
const TOOL_INPUT_CHARS = 2_000
const TOOL_RESULT_CHARS = 4_000
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

function renderClaudeBlock(block: unknown): string {
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

    return `[tool_use ${name}] ${clip(JSON.stringify(block.input ?? {}), TOOL_INPUT_CHARS)}`
  }
  if (block.type === 'tool_result') {
    const label = block.is_error === true ? 'tool_result error' : 'tool_result'

    return `[${label}] ${clip(textOf(block.content), TOOL_RESULT_CHARS)}`
  }

  return ''
}

/** One transcript JSONL line as a readable message, from Claude Code or Codex, or `undefined` for none. */
export function renderEntry(line: string): string | undefined {
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
      .map(renderClaudeBlock)
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

    return `assistant: [tool_use ${name}] ${clip(input, TOOL_INPUT_CHARS)}`
  }
  if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
    let output = payload.output
    if (isRecord(output)) {
      output = output.content ?? output
    }
    const text = typeof output === 'string' ? output : textOf(output) || JSON.stringify(output ?? null)

    return `tool: [tool_result] ${clip(text, TOOL_RESULT_CHARS)}`
  }

  return undefined
}

/**
 * Renders transcript JSONL lines as readable messages, stopping at a whole entry
 * once `maxChars` is reached so the reader can continue from `nextLine`.
 */
export function renderEntries(
  lines: readonly string[],
  firstLine: number,
  maxChars: number,
): { text: string; nextLine: number | undefined } {
  const parts: string[] = []
  let used = 0
  for (const [offset, line] of lines.entries()) {
    const rendered = renderEntry(line)
    if (rendered === undefined) {
      continue
    }
    const part = `L${firstLine + offset} ${rendered}`
    if (used > 0 && used + part.length > maxChars) {
      return { text: parts.join('\n\n'), nextLine: firstLine + offset }
    }
    parts.push(clip(part, maxChars))
    used += part.length
  }

  return { text: parts.join('\n\n'), nextLine: undefined }
}

/** What `recall` answers: one page of an archived segment, and where the next page starts. */
export async function recallText(
  store: Store,
  concept: string,
  number: number,
  fromLine: number | undefined,
): Promise<string> {
  const segments = await segmentsOf(store, concept)
  const segment = segments[number - 1]
  if (segment === undefined) {
    return `${concept} has ${segments.length} archived segments.`
  }
  if (!(await store.host.exists(segment.transcript))) {
    return `The archived transcript ${segment.transcript} no longer exists.`
  }
  const from = Math.min(Math.max(fromLine ?? segment.from, segment.from), segment.to)
  const to = Math.min(from + RECALL_CHUNK_LINES - 1, segment.to)
  const lines = await store.host.readLines(segment.transcript, from, to)
  const rendered = renderEntries(lines, from, RECALL_MAX_CHARS)
  const readUpTo = from + lines.length
  const next = rendered.nextLine ?? (readUpTo <= segment.to ? readUpTo : undefined)
  const footer =
    next === undefined
      ? `[end of segment #${number}]`
      : `[segment #${number} continues: call recall again with from_line=${next}]`

  return `Segment #${number} of ${concept}, archived ${segment.at}.\n\n${rendered.text || '(no messages in these lines)'}\n\n${footer}`
}
