import type { SessionMessage } from 'claude-code'

import { MARKER, clip, isRecord } from './core/common.ts'
import type { RecentNote } from './core/notes.ts'

export const PLUGIN = 'okf-wiki-handoff-mod'
export const SECTION_ID = `${PLUGIN}:handoff`

/** The tools the mod registers, by their short names. */
export const TOOL = {
  read: 'handoff_read',
  write: 'handoff_write',
  remaining: 'context_remaining',
  newContext: 'new_context',
  recall: 'recall',
} as const

export function toolId<Name extends string>(name: Name): `mcp__${typeof PLUGIN}__${Name}` {
  return `mcp__${PLUGIN}__${name}`
}

const TAIL_BUDGET_CHARS = 24_000
const RECENT_RESULTS_CHARS = 8_000

export type Plan = { title: string; handoff: string }

export const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    handoff: { type: 'string' },
  },
  required: ['title', 'handoff'],
}

const NOTE_SECTIONS = `- "# Goal": what the person asked for and what finished looks like.
- "# State": what is done and what is in progress, with exact file paths, branches, commands, identifiers, and changes not committed yet.
- "# Decisions and constraints": rules the person set in this conversation and decisions already made. Keep a rule's own wording where it matters; never soften or paraphrase a constraint. Leave out instructions from the system prompt and CLAUDE.md files, which stay in the context on their own.
- "# Next steps": the concrete next actions, in order.
- "# Open questions": what is unresolved or waiting on the person, or "None." when nothing is.`

export const RESET_INSTRUCTIONS = `${MARKER} new_context`

export const CONTINUE_PROMPT = `${MARKER} The context was reset to your handoff note at your request. Continue the task from the note.`

/** The system prompt section that sets the note-keeping protocol for the session. */
export function guidanceSection(options: {
  concept: string
  root: string
  recent: readonly RecentNote[]
}): string {
  const recent =
    options.recent.length === 0
      ? ''
      : `\n\nRecent handoff notes of other sessions in this project, which \`${toolId(TOOL.read)}\` reads by slug:\n${options.recent
          .map(note => `- \`${note.slug}\`: ${note.title || 'untitled'} (updated ${note.modified})`)
          .join('\n')}\nWhen the person continues one of these tasks, read that note and carry what still holds into this session's note.`

  return `# Context management

This session keeps a handoff note, the OKF concept \`${options.concept}\` in the bundle \`${options.root}\`. It is your working memory across context windows: when the context is reset or compacted, the conversation is replaced by this note, and the original messages survive only as archived segments. Only the main agent keeps the note; a subagent leaves it alone.

- Take incremental notes while you work. Rewrite the note with \`${toolId(TOOL.write)}\` whenever the goal, a decision, the state of the work or the next steps change, and before a long or risky step. Each write replaces the whole note, so pass it whole, in the language of the conversation, with these sections in this order:
${NOTE_SECTIONS}
  Record only what the conversation shows, and keep exact names, paths, commands, numbers and error messages.
- \`${toolId(TOOL.remaining)}\` tells how many tokens remain before automatic compaction; plan long steps against it.
- When a reminder says the context is nearly exhausted, save the note, call \`${toolId(TOOL.newContext)}\`, and end the turn with a one-line status. When the turn ends, the conversation is replaced by the note and the work continues in a fresh context window on its own. You may also do this at a natural checkpoint once most of the context is used.
- After a reset, the first message carries the note. When it lacks a detail you need, such as an exact command, error message or file content, call \`${toolId(TOOL.recall)}\` with a segment number instead of guessing.
- Treat the note as internal bookkeeping: you do not need to tell the person each time you update it.${recent}`
}

export function plannerPrompt(options: {
  concept: string
  current: string
  instructions: string | undefined
  recentResults: string | undefined
}): string {
  const current =
    options.current === ''
      ? 'You have not written the note yet.'
      : `This is the note as you last wrote it; it may be behind the conversation:\n<handoff-note>\n${options.current}\n</handoff-note>`
  const instructions =
    options.instructions === undefined || options.instructions.trim() === ''
      ? ''
      : `\nThe person asked this compaction to keep or stress: ${options.instructions.trim()}\n`
  const recent =
    options.recentResults === undefined
      ? ''
      : `\nThese tool results arrived after the last request above, so they may be missing from it:\n<recent-tool-results>\n${options.recentResults}\n</recent-tool-results>\n`

  return `This message comes from the ${PLUGIN} plugin, not from the user. The context window is full, so the conversation above is about to be replaced by your handoff note \`${options.concept}\`. Set the task aside and answer only with the note, brought up to date with the whole conversation.

${current}

After this you continue the work with only the note, the person's latest request and the most recent messages. Anything the note leaves out is lost unless you recall an archived segment, so write it for yourself.

Reply with one JSON object and nothing else: no prose and no code fence. It must match this JSON Schema:
${JSON.stringify(PLAN_SCHEMA)}

- "title": a short title for the task.
- "handoff": Markdown in the language of the conversation, with these sections in this order:
${NOTE_SECTIONS}
Record only what the conversation shows, and keep exact names, paths, commands, numbers and error messages.
${instructions}${recent}`
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
  const { title, handoff } = value
  if (typeof title !== 'string' || title.trim() === '' || typeof handoff !== 'string' || handoff.trim() === '') {
    return undefined
  }

  return { title: title.trim(), handoff: handoff.trim() }
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

export function handoffMessage(options: {
  root: string
  concept: string
  handoff: string
  prompt: string | undefined
  segments: number
  window: number
  isReset: boolean
}): string {
  const cause = options.isReset
    ? 'was reset at your request'
    : 'was compacted when the context window filled up'
  const prompt =
    options.prompt === undefined
      ? ''
      : `The person's latest request, verbatim:\n<<<\n${options.prompt}\n>>>\n\n`
  const note = options.handoff === '' ? '(The note is empty.)' : options.handoff
  const recall =
    options.segments === 0
      ? ''
      : `\n\nThe original messages are archived as segments #1-#${options.segments} of this note. When a detail you need is missing here, call ${toolId(TOOL.recall)} with a segment number instead of guessing.`

  return `${MARKER} This is context window #${options.window}. The conversation before this point ${cause} and was replaced by your handoff note below, the OKF concept ${options.concept} in the bundle ${options.root}. Keep updating it with ${toolId(TOOL.write)}.

${prompt}<handoff-note>
${note}
</handoff-note>${recall}`
}

export function periodicReminder(since: number): string {
  return `${MARKER} About ${since.toLocaleString('en-US')} tokens of work have passed since the handoff note was last updated. Update it with ${toolId(TOOL.write)} at the next good point.`
}

export function urgentReminder(options: { tokens: number; compactAt: number; isNoteCurrent: boolean }): string {
  const left = Math.max(options.compactAt - options.tokens, 0).toLocaleString('en-US')
  const action = options.isNoteCurrent
    ? `The note is current: call ${toolId(TOOL.newContext)} and end the turn with a one-line status.`
    : `Save a concise checkpoint with ${toolId(TOOL.write)} now, then call ${toolId(TOOL.newContext)} and end the turn with a one-line status.`

  return `${MARKER} The context window is nearly exhausted: about ${left} tokens remain before automatic compaction. ${action} The work continues in a fresh context window on its own.`
}

export function remainingText(options: {
  tokens: number | undefined
  window: number
  compactAt: number | undefined
}): string {
  if (options.tokens === undefined) {
    return `The context window holds ${options.window.toLocaleString('en-US')} tokens; its fill is unknown until the next response.`
  }
  const used = `${options.tokens.toLocaleString('en-US')} of ${options.window.toLocaleString('en-US')} tokens are in use (${Math.round((options.tokens / options.window) * 100)}%).`
  if (options.compactAt === undefined) {
    return `${used} Automatic compaction is off.`
  }
  const left = Math.max(options.compactAt - options.tokens, 0).toLocaleString('en-US')

  return `${used} Automatic compaction runs at ${options.compactAt.toLocaleString('en-US')} tokens, so about ${left} tokens remain.`
}
