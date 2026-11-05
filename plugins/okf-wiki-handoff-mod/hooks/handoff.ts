import type { SessionMessage } from 'claude-code'

import { MARKER, clip, isRecord } from './core/common.ts'
import { NOTE_CONTENT } from './core/notes.ts'
import type { RecentNote } from './core/notes.ts'

export const PLUGIN = 'okf-wiki-handoff-mod'
export const SECTION_ID = `${PLUGIN}:handoff`

/** The tools the mod registers, by their short names. */
export const TOOL = {
  read: 'handoff_read',
  write: 'handoff_write',
  append: 'handoff_append',
  search: 'handoff_search',
  remaining: 'context_remaining',
  newContext: 'new_context',
  historyList: 'history_list',
  historySearch: 'history_search',
  historyRead: 'history_read',
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
          .join('\n')}\nWhen the person continues one of these tasks, or an older one that \`${toolId(TOOL.search)}\` finds, read that note and carry what still holds into this session's note.`

  return `# Context management

This session keeps a handoff note, the OKF concept \`${options.concept}\` in the bundle \`${options.root}\`. It is your working memory across context windows: when the context is reset or compacted, the conversation is replaced by this note, while the original messages stay in the session's transcript. Only the main agent keeps this note; a subagent leaves it alone and is given a note of its own once its work runs long.

- Take notes while you work, in the language of the conversation. Add to the note with \`${toolId(TOOL.append)}\` as things happen: a decision, a finding, a finished step, a new rule from the person. Rewrite it whole with \`${toolId(TOOL.write)}\` to reorganize it or drop what no longer holds, and before a long or risky step. ${NOTE_CONTENT}
- \`${toolId(TOOL.remaining)}\` tells how many tokens remain before automatic compaction; plan long steps against it.
- When a reminder says the context is nearly exhausted, save the note, call \`${toolId(TOOL.newContext)}\`, and end the turn with a one-line status. When the turn ends, the conversation is replaced by the note and the work continues in a fresh context window on its own. You may also do this at a natural checkpoint once most of the context is used. A Stop hook, such as \`/goal\`'s, can keep the turn from ending; you are then told so, and keep working instead, since the automatic compaction replaces the conversation with the note.
- The original messages of every session of this project and of their subagents, compacted or not, stay readable: \`${toolId(TOOL.historyList)}\` lists the sessions and their context windows, \`${toolId(TOOL.historySearch)}\` finds messages that contain a text, and \`${toolId(TOOL.historyRead)}\` reads them a page at a time. When the note lacks a detail you need, such as an exact command, error message or file content, look it up there instead of guessing.
- \`${toolId(TOOL.search)}\` finds the handoff notes of this project that mention a text.
- Treat the note as internal bookkeeping: you do not need to tell the person each time you update it.${recent}`
}

/** Given to a subagent once its work runs long, never at its start, so a short subagent is left as it is. */
export function agentGuidance(options: { concept: string; root: string; sessionSlug: string; agentId: string }): string {
  return `${MARKER} Your work as a subagent has run long, so you now keep a handoff note of your own, the OKF concept \`${options.concept}\` in the bundle \`${options.root}\`. It is your working memory: when your context fills up, the compaction leaves only a summary of your conversation and you are told the note is there to read, while the original messages stay in your transcript. The main agent keeps its own note, which you leave alone.

- Add to your note with \`${toolId(TOOL.append)}\` as things happen: a decision, a finding, a finished step. Rewrite it whole with \`${toolId(TOOL.write)}\` to reorganize it or drop what no longer holds, and before a long or risky step. Both write your own note. Your task is what the agent that started you asked for. ${NOTE_CONTENT}
- \`${toolId(TOOL.read)}\` reads your note, or another note of this project by its slug; the main agent's is \`${options.sessionSlug}\`.
- \`${toolId(TOOL.historyRead)}\` with agent "${options.agentId}" reads your own original messages, and \`${toolId(TOOL.historySearch)}\` finds messages that contain a text. When the note lacks a detail you need, look it up there instead of guessing.
- Your final answer still goes to the agent that started you, as usual.`
}

/**
 * What a subagent is told after Claude Code compacted it: that its note is
 * there to read, not the note itself, which would repeat much of the summary.
 */
export function agentCompactedNotice(options: { concept: string; modified: string; agentId: string }): string {
  return `${MARKER} Your context was just compacted. You keep a handoff note, \`${options.concept}\`, last updated ${options.modified}. Read it with \`${toolId(TOOL.read)}\` before you continue, when the summary leaves out something you need; \`${toolId(TOOL.historyRead)}\` with agent "${options.agentId}" reads your original messages.`
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

After this you continue the work with only the note, the person's latest request and the most recent messages. Anything the note leaves out has to be looked up again in the transcript, so write it for yourself.

Reply with one JSON object and nothing else: no prose and no code fence. It must match this JSON Schema:
${JSON.stringify(PLAN_SCHEMA)}

- "title": a short title for the task.
- "handoff": the whole note, in Markdown in the language of the conversation. ${NOTE_CONTENT}
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
  const history = `\n\nThe original messages stay in this session's transcript. When a detail you need is missing here, find it with ${toolId(TOOL.historySearch)} or read it with ${toolId(TOOL.historyRead)} instead of guessing.`

  return `${MARKER} This is context window #${options.window}. The conversation before this point ${cause} and was replaced by your handoff note below, the OKF concept ${options.concept} in the bundle ${options.root}. Keep it current with ${toolId(TOOL.append)} and ${toolId(TOOL.write)}.

${prompt}<handoff-note>
${note}
</handoff-note>${history}`
}

export function periodicReminder(since: number): string {
  return `${MARKER} About ${since.toLocaleString('en-US')} tokens of work have passed since the handoff note was last updated. Update it with ${toolId(TOOL.write)} or ${toolId(TOOL.append)} at the next good point.`
}

export function urgentReminder(options: {
  tokens: number
  compactAt: number
  isNoteCurrent: boolean
  isTurnHeld: boolean
}): string {
  const left = Math.max(options.compactAt - options.tokens, 0).toLocaleString('en-US')
  if (options.isTurnHeld) {
    const save = options.isNoteCurrent ? 'The note is current.' : `Save a concise checkpoint with ${toolId(TOOL.write)} now.`

    return `${MARKER} The context window is nearly exhausted: about ${left} tokens remain before automatic compaction. ${save} ${heldTurnText()}`
  }
  const action = options.isNoteCurrent
    ? `The note is current: call ${toolId(TOOL.newContext)} and end the turn with a one-line status.`
    : `Save a concise checkpoint with ${toolId(TOOL.write)} now, then call ${toolId(TOOL.newContext)} and end the turn with a one-line status.`

  return `${MARKER} The context window is nearly exhausted: about ${left} tokens remain before automatic compaction. ${action} The work continues in a fresh context window on its own.`
}

/**
 * What the model is told once a Stop hook, such as `/goal`'s, kept the turn
 * going after `new_context`: the reset waits for the turn to end, which the
 * hook does not let happen, so ending the turn again only loops.
 */
export function heldTurnText(): string {
  return `A Stop hook (such as /goal's) keeps this turn going, so the turn does not end and ${toolId(TOOL.newContext)} cannot start a fresh context window in it. Do not end the turn to wait for one and do not call ${toolId(TOOL.newContext)} again in this turn: keep working on the task and keep the note current. When the context fills up, the automatic compaction replaces the conversation with your handoff note, as the reset would have.`
}

export function heldTurnNotice(): string {
  return `${MARKER} new_context was cancelled. ${heldTurnText()}`
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

/** A subagent's context as its transcript reports it; the session's window and threshold are the main agent's. */
export function agentRemainingText(tokens: number | undefined): string {
  const fill =
    tokens === undefined
      ? "Your context's fill as a subagent is unknown until your next response."
      : `About ${tokens.toLocaleString('en-US')} tokens are in use in your context as a subagent.`

  return `${fill} A subagent cannot start a fresh context window: when its context fills up, Claude Code compacts it as usual, so keep your handoff note current.`
}
