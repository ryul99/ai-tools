import type { SessionMessage } from 'claude-code'

export const HANDOFF_DIR = 'handoff'
export const HANDOFF_TAG = 'autosave-handoff'
export const HANDOFF_TYPE = 'Handoff'
export const MARKER = '[okf-wiki-handoff]'
export const RECALL_TOOL = 'mcp__okf-wiki-handoff-mod__recall'

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const TAIL_BUDGET_CHARS = 24_000
const RECENT_RESULTS_CHARS = 8_000
const TOOL_INPUT_CHARS = 2_000
const TOOL_RESULT_CHARS = 4_000

export type Segment = { at: string; transcript: string; from: number; to: number }

export type HandoffEntry = { slug: string; title: string }

export type Plan = { slug: string; title: string; handoff: string }

export const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    slug: { type: 'string', pattern: SLUG_PATTERN.source },
    title: { type: 'string' },
    handoff: { type: 'string' },
  },
  required: ['slug', 'title', 'handoff'],
}

export function plannerPrompt(options: {
  currentSlug: string | undefined
  known: readonly HandoffEntry[]
  instructions: string | undefined
  recentResults: string | undefined
}): string {
  const slugRule =
    options.currentSlug === undefined
      ? '"slug": the slug in <known> whose task this conversation continues; only when none matches, a new kebab-case slug naming the task.'
      : `"slug": exactly "${options.currentSlug}", the handoff this session already writes to.`
  const instructions =
    options.instructions === undefined || options.instructions.trim() === ''
      ? ''
      : `\nThe person asked this compaction to keep or stress: ${options.instructions.trim()}\n`
  const recent =
    options.recentResults === undefined
      ? ''
      : `\nThese tool results arrived after the last request above, so they may be missing from it:\n<recent-tool-results>\n${options.recentResults}\n</recent-tool-results>\n`

  return `This message comes from the okf-wiki-handoff-mod plugin, not from the user. The context window is full, so the conversation above is about to be replaced by a handoff note that you write now. Set the task aside and answer only with that note.

After this you continue the work with only the note, the person's latest request and the most recent messages. Anything the note leaves out is lost unless you recall an archived segment, so write it for yourself.

Reply with one JSON object and nothing else: no prose and no code fence. It must match this JSON Schema:
${JSON.stringify(PLAN_SCHEMA)}

- ${slugRule}
- "title": a short title for the task.
- "handoff": Markdown in the language of the conversation, with these sections in this order:
  - "## Goal": what the person asked for and what finished looks like.
  - "## State": what is done and what is in progress, with exact file paths, branches, commands, identifiers, and changes not committed yet.
  - "## Decisions and constraints": rules the person set in this conversation and decisions already made. Keep a rule's own wording where it matters; never soften or paraphrase a constraint. Leave out instructions from the system prompt and CLAUDE.md files, which stay in the context on their own.
  - "## Next steps": the concrete next actions, in order.
  - "## Open questions": what is unresolved or waiting on the person, or "None." when nothing is.
Record only what the conversation shows, and keep exact names, paths, commands, numbers and error messages. Do not add an archive section; the plugin appends one.
${instructions}${recent}
<known>
${JSON.stringify(options.known)}
</known>`
}

export function parsePlan(reply: string): Plan | undefined {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start === -1 || end <= start) {
    return undefined
  }
  let value: unknown
  try {
    value = JSON.parse(reply.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (!isRecord(value)) {
    return undefined
  }
  const { slug, title, handoff } = value
  if (
    typeof slug !== 'string' ||
    !SLUG_PATTERN.test(slug) ||
    typeof title !== 'string' ||
    title.trim() === '' ||
    typeof handoff !== 'string' ||
    handoff.trim() === ''
  ) {
    return undefined
  }

  return { slug, title: title.trim(), handoff: handoff.trim() }
}

function isPrompt(message: SessionMessage): boolean {
  return (
    message.role === 'user' &&
    (message.toolResults?.length ?? 0) === 0 &&
    message.text.trim() !== '' &&
    !message.text.startsWith(MARKER)
  )
}

function messageSize(message: SessionMessage): number {
  return (
    message.text.length +
    JSON.stringify(message.toolUses).length +
    JSON.stringify(message.toolResults ?? []).length
  )
}

/**
 * The newest whole turns that fit the budget, opening on a person's prompt so a
 * kept tool result never loses the tool call it answers.
 */
export function keptTail(messages: readonly SessionMessage[]): SessionMessage[] {
  let total = 0
  let start = messages.length
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined) {
      break
    }
    total += messageSize(message)
    if (total > TAIL_BUDGET_CHARS) {
      break
    }
    if (isPrompt(message)) {
      start = index
    }
  }

  return messages.slice(start)
}

export function latestPrompt(messages: readonly SessionMessage[]): string | undefined {
  return messages.findLast(isPrompt)?.text
}

export function recentToolResults(messages: readonly SessionMessage[]): string | undefined {
  const results = messages.at(-1)?.toolResults ?? []
  if (results.length === 0) {
    return undefined
  }
  const text = results
    .map(result => `[${result.isError ? 'error' : 'result'}] ${result.text}`)
    .join('\n')

  return clip(text, RECENT_RESULTS_CHARS)
}

/** Names a project the way Claude Code names its folders under `projects/`. */
export function projectKey(projectRoot: string): string {
  return projectRoot.replace(/[^A-Za-z0-9]/g, '-')
}

export function archiveSection(segments: readonly Segment[]): string {
  const lines = segments.map(
    (segment, index) =>
      `- #${index + 1}: transcript lines ${segment.from}-${segment.to}, archived ${segment.at}`,
  )

  return `## Archived segments

The original conversation is archived as the transcript line ranges in this note's
\`segments\` frontmatter. Read a segment with the \`recall\` tool of okf-wiki-handoff-mod.

${lines.join('\n')}
`
}

export function noteBody(handoff: string, segments: readonly Segment[]): string {
  const body = `${handoff.trimEnd()}\n`

  return segments.length === 0 ? body : `${body}\n${archiveSection(segments)}`
}

export function handoffMessage(options: {
  root: string
  concept: string
  handoff: string
  prompt: string | undefined
  segments: number
}): string {
  const prompt =
    options.prompt === undefined
      ? ''
      : `The person's latest request, verbatim:\n<<<\n${options.prompt}\n>>>\n\n`
  const recall =
    options.segments === 0
      ? ''
      : `\n\nThe original messages are archived as segments #1-#${options.segments} of this handoff. When a detail you need is missing here, call ${RECALL_TOOL} with a segment number instead of guessing.`

  return `${MARKER} The conversation before this point was replaced by the handoff note below, which you wrote from the full conversation when the context window filled up. It is also saved as the OKF concept ${options.concept} in the bundle ${options.root}.

${prompt}${options.handoff}${recall}`
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

function renderEntry(line: string): string | undefined {
  let entry: unknown
  try {
    entry = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!isRecord(entry) || (entry.type !== 'user' && entry.type !== 'assistant')) {
    return undefined
  }
  const message = entry.message
  if (!isRecord(message)) {
    return undefined
  }
  const content = message.content
  const blocks = Array.isArray(content) ? content : [content]
  const text = blocks
    .map(renderBlock)
    .filter(part => part !== undefined && part !== '')
    .join('\n')

  return text === '' ? undefined : `${entry.type}: ${text}`
}

function renderBlock(block: unknown): string | undefined {
  if (typeof block === 'string') {
    return block
  }
  if (!isRecord(block)) {
    return undefined
  }
  if (block.type === 'text') {
    return typeof block.text === 'string' ? block.text : undefined
  }
  if (block.type === 'tool_use') {
    const name = typeof block.name === 'string' ? block.name : 'tool'

    return `[tool_use ${name}] ${clip(JSON.stringify(block.input ?? {}), TOOL_INPUT_CHARS)}`
  }
  if (block.type === 'tool_result') {
    const label = block.is_error === true ? 'tool_result error' : 'tool_result'

    return `[${label}] ${clip(resultText(block.content), TOOL_RESULT_CHARS)}`
  }

  return undefined
}

function resultText(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }

  return content
    .map(item => (isRecord(item) && typeof item.text === 'string' ? item.text : ''))
    .filter(text => text !== '')
    .join('\n')
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)} [clipped]`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
