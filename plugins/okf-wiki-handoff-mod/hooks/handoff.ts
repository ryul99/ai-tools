import type { SessionMessage } from 'claude-code'

import { MARKER, clip, isRecord } from './core/common.ts'
import { NOTE_CONTENT, NOTE_UPKEEP } from './core/notes.ts'

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
export function guidanceSection(options: { concept: string; root: string }): string {
  return `# Context management

This session keeps a handoff note, the OKF concept \`${options.concept}\` in the bundle \`${options.root}\`. When the context is reset or compacted, the conversation is replaced by this note, while the original messages stay in the session's transcript. A subagent leaves this note alone and is given one of its own once its work runs long.

- Keep the note current as you work, in the language of the conversation. ${NOTE_UPKEEP} Every context window starts by reading all of it, so what is outdated costs room and misleads. When and how you update it is your call, and the person does not need to hear about it.
- ${NOTE_CONTENT}
- Plan long steps against \`${toolId(TOOL.remaining)}\`. When little context remains, or at a natural checkpoint late in the window, bring the note up to date and call \`${toolId(TOOL.newContext)}\`, so that the window changes at a point you chose.`
}

/** Given to a subagent once its work runs long, never at its start, so a short subagent is left as it is. */
export function agentGuidance(options: { concept: string; root: string; sessionSlug: string; agentId: string }): string {
  return `${MARKER} Your work as a subagent has run long, so you now keep a handoff note of your own, the OKF concept \`${options.concept}\` in the bundle \`${options.root}\`. When your context fills up, compaction leaves only a summary and you are told the note is there to read.

Keep it current with \`${toolId(TOOL.append)}\` and \`${toolId(TOOL.write)}\`, which write your own note. ${NOTE_UPKEEP} ${NOTE_CONTENT} Here the person is the agent that started you, and your final answer still goes to it. \`${toolId(TOOL.read)}\` with handoff "${options.sessionSlug}" reads the main agent's note, and \`${toolId(TOOL.historyRead)}\` with agent "${options.agentId}" your own original messages.`
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

/** The session guidance, always in the system prompt, already names the note and how to keep it and look behind it. */
export function handoffMessage(options: { handoff: string; prompt: string | undefined; window: number }): string {
  const prompt =
    options.prompt === undefined
      ? ''
      : `The person's latest request, verbatim:\n<<<\n${options.prompt}\n>>>\n\n`
  const note = options.handoff === '' ? '(The note is empty.)' : options.handoff

  return `${MARKER} This is context window #${options.window}. The earlier conversation was replaced by your handoff note below.

${prompt}<handoff-note>
${note}
</handoff-note>`
}

export function periodicReminder(since: number): string {
  return `${MARKER} About ${since.toLocaleString('en-US')} tokens of work have passed since the handoff note was last updated. Bring it up to date at the next good point.`
}

export function urgentReminder(options: { tokens: number; compactAt: number; isTurnHeld: boolean }): string {
  const left = Math.max(options.compactAt - options.tokens, 0).toLocaleString('en-US')
  const remaining = `${MARKER} About ${left} tokens remain before automatic compaction.`

  return options.isTurnHeld
    ? `${remaining} Make sure the note is current. ${heldTurnText()}`
    : `${remaining} Make sure the note is current, then call ${toolId(TOOL.newContext)}.`
}

/**
 * What the model is told once a Stop hook, such as `/goal`'s, kept the turn
 * going after `new_context`: the reset waits for the turn to end, which the
 * hook does not let happen, so ending the turn again only loops.
 */
export function heldTurnText(): string {
  return `A Stop hook (such as /goal's) keeps this turn going, so ${toolId(TOOL.newContext)} cannot take effect in it. Keep working and keep the note current, without ending the turn to wait or calling ${toolId(TOOL.newContext)} again: when the context fills up, automatic compaction replaces the conversation with the note all the same.`
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
