import { READ_ONLY_TOOLS } from './fast-path.ts'

interface EntryLike {
  type: string
  message?: {
    role: string
    content?: unknown
  }
}

const FIELD_LIMIT = 4_000
const TRANSCRIPT_LIMIT = 48_000
const FIRST_MESSAGE_LIMIT = 6_000

function clip(text: string, limit: number): string {
  if (text.length <= limit) {
    return text
  }
  const head = Math.floor(limit * 0.75)
  const tail = limit - head
  return `${text.slice(0, head)}\n…[${text.length - limit} characters omitted]…\n${text.slice(text.length - tail)}`
}

function clipValues(value: unknown): unknown {
  if (typeof value === 'string') {
    return clip(value, FIELD_LIMIT)
  }
  if (Array.isArray(value)) {
    return value.map(clipValues)
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clipValues(item)]))
  }
  return value
}

export function renderAction(toolName: string, input: unknown): string {
  return `${toolName} ${JSON.stringify(clipValues(input), null, 1)}`
}

function userText(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  return content.map(block => block?.type === 'text' ? block.text : block?.type === 'image' ? '[image]' : '').filter(Boolean).join('\n')
}

/**
 * The classifier's view of the session: the user's messages and the agent's actions, without the
 * agent's prose, its reasoning, or any tool output, so that neither the agent nor content it read
 * can argue with the reviewer. Read-only lookups are left out as noise.
 */
export function projectTranscript(entries: EntryLike[], pendingCallId?: string): string {
  const items: string[] = []
  let firstUser = -1
  for (const entry of entries) {
    const message = entry.type === 'message' ? entry.message : undefined
    if (message?.role === 'user') {
      const text = userText(message.content).trim()
      if (text !== '') {
        if (firstUser < 0) {
          firstUser = items.length
        }
        items.push(`[user]\n${items.length === firstUser ? clip(text, FIRST_MESSAGE_LIMIT) : clip(text, FIELD_LIMIT)}`)
      }
    } else if (message?.role === 'assistant' && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type === 'toolCall' && block.id !== pendingCallId && !READ_ONLY_TOOLS.has(block.name)) {
          items.push(`[agent action]\n${renderAction(block.name, block.arguments)}`)
        }
      }
    }
  }

  let total = items.reduce((sum, item) => sum + item.length + 2, 0)
  let start = 0
  const kept = new Set(items.keys())
  while (total > TRANSCRIPT_LIMIT && start < items.length - 1) {
    if (start !== firstUser) {
      kept.delete(start)
      total -= items[start].length + 2
    }
    start++
  }
  const lines = items.filter((_, index) => kept.has(index))
  if (kept.size < items.length) {
    lines.splice(firstUser >= 0 && kept.has(firstUser) ? 1 : 0, 0, `[${items.length - kept.size} earlier items omitted]`)
  }
  return lines.join('\n\n')
}

const DESCRIPTION_LIMIT = 1_500

export interface ToolDescription {
  text: string
  /** Where the tool comes from, such as `user extension` or `MCP`. */
  source: string
  trusted: boolean
}

function escapeAttribute(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

export function reviewRequest(transcript: string, toolName: string, input: unknown, tool?: ToolDescription): string {
  // A description that closes its element could pose as the pending action or the transcript.
  const description = tool === undefined || tool.text.trim() === '' ? '' : `

<tool_description tool="${escapeAttribute(toolName)}" source="${escapeAttribute(tool.source)}" trust="${tool.trusted ? 'extension' : 'untrusted'}">
${clip(tool.text.trim(), DESCRIPTION_LIMIT).replace(/<(\/?)(tool_description|pending_action|transcript)/gi, '[$1$2')}
</tool_description>`
  return `<transcript>
${transcript === '' ? '(no earlier messages)' : transcript}
</transcript>${description}

<pending_action>
${renderAction(toolName, input)}
</pending_action>`
}
