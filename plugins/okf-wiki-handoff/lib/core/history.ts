import { clip, isRecord, projectKey, sessionSlug } from './common.ts'
import { utcMinute } from './notes.ts'
import type { Host } from './notes.ts'
import { TOOL_INPUT_CHARS, TOOL_RESULT_CHARS, renderEntries, renderEntry } from './transcript.ts'
import type { Detail } from './transcript.ts'

export const READ_CHUNK_LINES = 200
export const READ_MAX_CHARS = 30_000
export const DEFAULT_LIST_LIMIT = 20
export const DEFAULT_SEARCH_LIMIT = 20
export const MAX_RESULTS = 100
const MATCHES_PER_FILE = 200
const BOUNDARIES_PER_FILE = 10_000
const SNIPPET_CHARS = 160
const PREVIEW_LINES = 80
const PREVIEW_CHARS = 120
const CODEX_DEPTH = 3
const ALL_SESSIONS = 'all'

// The history tools' own calls and answers are left out of a search, which would otherwise find itself.
const OWN_TOOL_USE = /\[tool_use [^\]]*history_(?:list|search|read)\]/
const LIST_HEADER = 'History sessions'
const SEARCH_HEADER = 'History search'
const READ_HEADER = 'History of session'
const OWN_RESULTS = [LIST_HEADER, SEARCH_HEADER, READ_HEADER].map(header => `[tool_result] ${header}`)

/** Where a project's transcripts are and which session is asking. */
export type Locator = {
  kind: 'claude' | 'codex'
  /** Claude Code's `projects` directory, or Codex's `sessions` directory. */
  root: string
  /** The project's key, as `projectKey` makes it from the project root. */
  key: string
  sessionId: string
}

type Agent = { id: string; path: string; label: string }
type Session = { id: string; path: string; mtimeMs: number; agents: Agent[] }

function sameSession(left: string, right: string): boolean {
  return sessionSlug(left) === sessionSlug(right)
}

function parsed(line: string | undefined): Record<string, unknown> | undefined {
  if (line === undefined) {
    return undefined
  }
  try {
    const value: unknown = JSON.parse(line)

    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Finding the transcripts

/** The project's transcript folder, or, when the project root was named differently, the one that holds this session. */
async function claudeFolder(host: Host, locator: Locator): Promise<string | undefined> {
  const named = `${locator.root}/${locator.key}`
  if (await host.exists(named)) {
    return named
  }
  for (const entry of await host.list(locator.root)) {
    const folder = `${locator.root}/${entry.name}`
    if (entry.kind === 'dir' && (await host.exists(`${folder}/${locator.sessionId}.jsonl`))) {
      return folder
    }
  }

  return undefined
}

/** A Claude Code subagent's transcript in the asking session, or `undefined` before it exists. */
export async function claudeAgentTranscript(host: Host, locator: Locator, agentId: string): Promise<string | undefined> {
  const folder = await claudeFolder(host, locator)
  const path = folder === undefined ? undefined : `${folder}/${locator.sessionId}/subagents/agent-${agentId}.jsonl`

  return path !== undefined && (await host.exists(path)) ? path : undefined
}

async function claudeAgents(host: Host, folder: string): Promise<Agent[]> {
  const agents: Agent[] = []
  if (!(await host.exists(folder))) {
    return agents
  }
  for (const entry of await host.list(folder)) {
    const match = /^agent-(.+)\.jsonl$/.exec(entry.name)
    if (entry.kind !== 'file' || match?.[1] === undefined) {
      continue
    }
    const meta = parsed(await host.readText(`${folder}/agent-${match[1]}.meta.json`))
    const label = [meta?.agentType, meta?.description].filter(part => typeof part === 'string' && part !== '').join(': ')
    agents.push({ id: match[1], path: `${folder}/${entry.name}`, label })
  }

  return agents
}

async function claudeSessions(host: Host, locator: Locator): Promise<Session[]> {
  const folder = await claudeFolder(host, locator)
  if (folder === undefined) {
    return []
  }
  const sessions: Session[] = []
  for (const entry of await host.list(folder)) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.jsonl')) {
      continue
    }
    const id = entry.name.slice(0, -'.jsonl'.length)
    sessions.push({
      id,
      path: `${folder}/${entry.name}`,
      mtimeMs: entry.mtimeMs,
      agents: await claudeAgents(host, `${folder}/${id}/subagents`),
    })
  }

  return sessions
}

async function rollouts(host: Host, folder: string, depth: number): Promise<{ path: string; mtimeMs: number }[]> {
  const found: { path: string; mtimeMs: number }[] = []
  for (const entry of await host.list(folder)) {
    const path = `${folder}/${entry.name}`
    if (entry.kind === 'dir' && depth > 0) {
      found.push(...(await rollouts(host, path, depth - 1)))
    } else if (entry.kind === 'file' && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
      found.push({ path, mtimeMs: entry.mtimeMs })
    }
  }

  return found
}

/** A Codex rollout's thread, its project, and the thread that spawned it, from its `session_meta` line. */
function codexMeta(line: string | undefined): { id: string; cwd: string; parent?: string; label: string } | undefined {
  const item = parsed(line)
  const payload = item?.payload
  if (item?.type !== 'session_meta' || !isRecord(payload) || typeof payload.id !== 'string' || typeof payload.cwd !== 'string') {
    return undefined
  }
  const source = isRecord(payload.source) ? payload.source : undefined
  const subagent = source?.subagent
  const spawn = isRecord(subagent) && isRecord(subagent.thread_spawn) ? subagent.thread_spawn : undefined
  const parent = [payload.parent_thread_id, spawn?.parent_thread_id].find(value => typeof value === 'string')
  const label = typeof subagent === 'string'
    ? subagent
    : [spawn?.agent_role, spawn?.agent_nickname].filter(part => typeof part === 'string' && part !== '').join(': ')

  return { id: payload.id, cwd: payload.cwd, parent: parent as string | undefined, label }
}

async function codexSessions(host: Host, locator: Locator): Promise<Session[]> {
  const threads: (Session & { parent?: string; label: string })[] = []
  for (const file of await rollouts(host, locator.root, CODEX_DEPTH)) {
    const meta = codexMeta((await host.readLines(file.path, 1, 1))[0])
    if (meta !== undefined && projectKey(meta.cwd) === locator.key) {
      threads.push({ id: meta.id, path: file.path, mtimeMs: file.mtimeMs, agents: [], parent: meta.parent, label: meta.label })
    }
  }
  const byId = new Map(threads.map(thread => [thread.id, thread]))
  const sessions: Session[] = []
  for (const thread of threads) {
    const parent = thread.parent === undefined ? undefined : byId.get(thread.parent)
    if (parent === undefined) {
      sessions.push(thread)
    } else {
      parent.agents.push({ id: thread.id, path: thread.path, label: thread.label })
    }
  }

  return sessions
}

/** The project's sessions, newest first. */
async function projectSessions(host: Host, locator: Locator): Promise<Session[]> {
  if (!(await host.exists(locator.root))) {
    return []
  }
  const sessions = locator.kind === 'claude' ? await claudeSessions(host, locator) : await codexSessions(host, locator)

  return sessions.sort((left, right) => right.mtimeMs - left.mtimeMs)
}

/** The lines that open each context window: the first line, then each compaction's. */
async function windowStarts(host: Host, kind: Locator['kind'], path: string): Promise<number[]> {
  const hits = await host.grep(path, kind === 'claude' ? 'compact_boundary' : 'compacted', BOUNDARIES_PER_FILE)
  const items = hits.map(hit => ({ number: hit.number, item: parsed(hit.text) }))
  let boundaries: number[]
  if (kind === 'claude') {
    boundaries = items
      .filter(({ item }) => item?.type === 'system' && item.subtype === 'compact_boundary')
      .map(({ number }) => number)
  } else {
    // A Codex compaction records the replaced history and an event; the event is the fallback for older rollouts.
    const replaced = items.filter(({ item }) => item?.type === 'compacted').map(({ number }) => number)
    boundaries = replaced.length > 0
      ? replaced
      : items
          .filter(({ item }) => item?.type === 'event_msg' && isRecord(item.payload) && item.payload.type === 'context_compacted')
          .map(({ number }) => number)
  }

  return [1, ...boundaries.filter(number => number > 1)]
}

function windowOf(starts: readonly number[], line: number): number {
  return starts.filter(start => start <= line).length
}

function unknownSession(session: string): string {
  return `No session \`${session}\` in this project. List the sessions with history_list and "session" as "${ALL_SESSIONS}".`
}

// ---------------------------------------------------------------------------
// Tools

function firstPrompt(lines: readonly string[]): string | undefined {
  for (const line of lines) {
    const rendered = renderEntry(line)
    if (rendered?.startsWith('user: ') && !rendered.startsWith('user: [tool_result') && !rendered.startsWith('user: <')) {
      return clip(rendered.slice('user: '.length).replace(/\s+/g, ' ').trim(), PREVIEW_CHARS)
    }
  }

  return undefined
}

/** What `history_list` answers: one session's context windows and subagents, or every session of the project. */
export async function historyListText(
  host: Host,
  locator: Locator,
  options: { session?: string; limit: number; titleOf: (sessionId: string) => Promise<string> },
): Promise<string> {
  const sessions = await projectSessions(host, locator)
  const mine = (session: Session) => (sameSession(session.id, locator.sessionId) ? ' (this session)' : '')
  const named = options.session ?? locator.sessionId
  if (named !== ALL_SESSIONS) {
    const session = sessions.find(candidate => sameSession(candidate.id, named))
    if (session === undefined) {
      return unknownSession(named)
    }
    const total = await host.lineCount(session.path)
    const starts = await windowStarts(host, locator.kind, session.path)
    const windows = starts.map((start, index) => `- #${index + 1}: L${start}-L${(starts[index + 1] ?? total + 1) - 1}`)
    const agents: string[] = []
    for (const agent of session.agents) {
      agents.push(`- \`${agent.id}\`${agent.label === '' ? '' : `: ${agent.label}`} (${(await host.lineCount(agent.path)).toLocaleString('en-US')} lines)`)
    }

    return `${LIST_HEADER}: \`${session.id}\`${mine(session)}, ${session.path}

Context windows:
${windows.join('\n')}

Subagents:
${agents.length === 0 ? '(none)' : agents.join('\n')}

Pass "session" as "${ALL_SESSIONS}" to list every session of this project.`
  }
  if (sessions.length === 0) {
    return `${LIST_HEADER}: no transcript of this project was found under ${locator.root}.`
  }
  const shown = sessions.slice(0, options.limit)
  const parts: string[] = []
  for (const session of shown) {
    const lines = (await host.lineCount(session.path)).toLocaleString('en-US')
    const windows = (await windowStarts(host, locator.kind, session.path)).length
    const title = await options.titleOf(session.id)
    const prompt = firstPrompt(await host.readLines(session.path, 1, PREVIEW_LINES))
    parts.push(
      [
        `- \`${session.id}\`${mine(session)}: updated ${utcMinute(session.mtimeMs)}, ${lines} lines, ${windows} windows, ${session.agents.length} subagents`,
        title === '' ? undefined : `  note: ${title}`,
        prompt === undefined ? undefined : `  first prompt: ${prompt}`,
      ]
        .filter(line => line !== undefined)
        .join('\n'),
    )
  }

  return `${LIST_HEADER} of this project, newest first (${shown.length} of ${sessions.length}). Pass a session id as "session" for its context windows and subagents.

${parts.join('\n')}`
}

/** What `history_search` answers: messages of one session, or of every session newest first, that contain `query`, ignoring case. */
export async function historySearchText(
  host: Host,
  locator: Locator,
  options: { query: string; session?: string; limit: number },
): Promise<string> {
  const query = options.query.trim()
  if (query === '') {
    return 'Pass "query" as the text to find.'
  }
  const sessions = await projectSessions(host, locator)
  const named = options.session ?? locator.sessionId
  const isAll = named === ALL_SESSIONS
  const targets = isAll ? sessions : sessions.filter(session => sameSession(session.id, named))
  if (!isAll && targets.length === 0) {
    return unknownSession(named)
  }
  // The transcript holds the text JSON-encoded, so the raw lines are matched that way and the rendered message confirms it.
  const needle = JSON.stringify(query).slice(1, -1)
  const lowered = query.toLowerCase()
  const results: string[] = []
  let isMore = false
  search: for (const session of targets) {
    const files = [{ path: session.path, agent: undefined as string | undefined }, ...session.agents.map(agent => ({ path: agent.path, agent: agent.id }))]
    for (const file of files) {
      let starts: number[] | undefined
      for (const hit of await host.grep(file.path, needle, MATCHES_PER_FILE)) {
        const rendered = renderEntry(hit.text, 'full')
        const at = rendered?.toLowerCase().indexOf(lowered) ?? -1
        if (rendered === undefined || at === -1 || OWN_TOOL_USE.test(rendered) || OWN_RESULTS.some(own => rendered.includes(own))) {
          continue
        }
        if (results.length === options.limit) {
          isMore = true
          break search
        }
        starts ??= await windowStarts(host, locator.kind, file.path)
        const role = rendered.slice(0, rendered.indexOf(':'))
        const from = Math.max(at - SNIPPET_CHARS, role.length + 2)
        const to = Math.min(at + query.length + SNIPPET_CHARS, rendered.length)
        const snippet = `${from > role.length + 2 ? '…' : ''}${rendered.slice(from, to).replace(/\s+/g, ' ')}${to < rendered.length ? '…' : ''}`
        const agent = file.agent === undefined ? '' : ` agent \`${file.agent}\``
        results.push(`- \`${session.id}\`${agent} window #${windowOf(starts, hit.number)} L${hit.number} ${role}: ${snippet}`)
      }
    }
  }
  if (results.length === 0) {
    return isAll
      ? `${SEARCH_HEADER} "${query}": no message matches in any session.`
      : `${SEARCH_HEADER} "${query}": no message matches in session \`${named}\`. Pass "session" as "${ALL_SESSIONS}" to search every session of this project.`
  }
  const more = isMore ? `\n\n[more matches: narrow the query${isAll ? ', pass a session id as "session",' : ''} or raise "limit"]` : ''

  return `${SEARCH_HEADER} "${query}": ${results.length} matches${isAll ? ', newest sessions first' : ''}. Read around one with history_read and its session, agent and from_line.

${results.join('\n')}${more}`
}

/** What `history_read` answers: one page of a session's or subagent's messages, and where the next page starts. */
export async function historyReadText(
  host: Host,
  locator: Locator,
  options: { session?: string; agent?: string; fromLine?: number; toLine?: number; detail: Detail },
): Promise<string> {
  const from = options.fromLine ?? 1
  if (options.toLine !== undefined && options.toLine < from) {
    return `Pass "to_line" at or after "from_line" (L${from}).`
  }
  const named = options.session ?? locator.sessionId
  const session = (await projectSessions(host, locator)).find(candidate => sameSession(candidate.id, named))
  if (session === undefined) {
    return unknownSession(named)
  }
  let path = session.path
  let label = `\`${session.id}\``
  if (options.agent !== undefined) {
    const agent = session.agents.find(candidate => candidate.id === options.agent)
    if (agent === undefined) {
      return `Session \`${session.id}\` has no subagent \`${options.agent}\`. List its subagents with history_list and "session".`
    }
    path = agent.path
    label += `, agent \`${agent.id}\``
  }
  const total = await host.lineCount(path)
  if (from > total) {
    return `${READ_HEADER} ${label}: the transcript ends at L${total}.`
  }
  const last = Math.min(options.toLine ?? total, total)
  const starts = await windowStarts(host, locator.kind, path)
  const lines = await host.readLines(path, from, Math.min(from + READ_CHUNK_LINES - 1, last))
  const marks = new Map(
    starts.map((start, index) => [start, `--- context window #${index + 1} starts ---`] as const),
  )
  const rendered = renderEntries(lines, from, READ_MAX_CHARS, marks, options.detail)
  const readUpTo = from + lines.length
  const next = rendered.nextLine ?? (readUpTo <= last && lines.length > 0 ? readUpTo : undefined)
  const scope = last === total ? 'the transcript' : `L${last}`
  const footer = next === undefined
    ? `[end of ${scope}]`
    : `[continues to ${scope}: call history_read again with the same arguments and from_line=${next}]`
  const window = windowOf(starts, from)

  return `${READ_HEADER} ${label}, window #${window} of ${starts.length}, from L${from} of ${total}.

${rendered.text || '(no messages in these lines)'}

${footer}`
}

// ---------------------------------------------------------------------------
// Tool definitions, shared by the plugin's MCP server and the mod

const SESSION_PROPERTY = {
  type: 'string',
  description: "A session id from history_list; defaults to this session.",
}

/** The history tools by name: what each does and the input it takes, without the plugin's own properties. */
export const HISTORY_TOOLS = {
  history_list: {
    description:
      `List the context windows by line range and the subagents of this session or another session of this project; or, with session "${ALL_SESSIONS}", this project's sessions, newest first, with each one's context window count, subagent count, note title and first prompt.`,
    properties: {
      session: {
        type: 'string',
        description: `A session id, to list its context windows and subagents, or "${ALL_SESSIONS}" to list every session of this project; defaults to this session.`,
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_RESULTS,
        description: `How many sessions to list with session "${ALL_SESSIONS}", where it alone applies; ${DEFAULT_LIST_LIMIT} by default.`,
      },
    },
    required: [] as string[],
  },
  history_search: {
    description:
      "Find the original messages of this session and its subagents, or of another session of this project, that contain a text, ignoring case: user prompts, replies, tool calls and tool results, compacted or not. Each match gives the session, agent, context window and line to read around with history_read.",
    properties: {
      query: { type: 'string', description: 'The literal text to find, such as an error message, a path or a command.' },
      session: {
        type: 'string',
        description: `A session id from history_list to search that session and its subagents, or "${ALL_SESSIONS}" for every session of this project; defaults to this session.`,
      },
      limit: { type: 'integer', minimum: 1, maximum: MAX_RESULTS, description: `How many matches to return; ${DEFAULT_SEARCH_LIMIT} by default.` },
    },
    required: ['query'],
  },
  history_read: {
    description:
      "Read the original messages of a session of this project, or of one of its subagents, a page at a time, between two transcript lines: around a match history_search gave, or over a context window's lines from history_list.",
    properties: {
      session: SESSION_PROPERTY,
      agent: { type: 'string', description: "A subagent id from history_list or history_search, to read that subagent's transcript." },
      from_line: { type: 'integer', minimum: 1, description: 'The transcript line to start from, such as a match or a previous page gave; the first line by default.' },
      to_line: { type: 'integer', minimum: 1, description: 'The last transcript line to read, inclusive; the end of the transcript by default.' },
      detail: {
        type: 'string',
        enum: ['brief', 'full'],
        description: `"brief" (the default) cuts each tool call's input at ${TOOL_INPUT_CHARS.toLocaleString('en-US')} characters and its result at ${TOOL_RESULT_CHARS.toLocaleString('en-US')}; "full" keeps them whole, up to ${READ_MAX_CHARS.toLocaleString('en-US')} characters a message.`,
      },
    },
    required: [] as string[],
  },
} as const

export type HistoryToolName = keyof typeof HISTORY_TOOLS

export function isHistoryTool(name: string): name is HistoryToolName {
  return Object.hasOwn(HISTORY_TOOLS, name)
}

function textInput(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key]

  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function countInput(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key]

  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/** Runs a history tool on its raw input. */
export function runHistoryTool(
  name: HistoryToolName,
  host: Host,
  locator: Locator,
  input: Record<string, unknown>,
  titleOf: (sessionId: string) => Promise<string>,
): Promise<string> {
  const limit = (fallback: number) => Math.min(countInput(input, 'limit') ?? fallback, MAX_RESULTS)
  const session = textInput(input, 'session')
  switch (name) {
    case 'history_list':
      return historyListText(host, locator, { session, limit: limit(DEFAULT_LIST_LIMIT), titleOf })
    case 'history_search':
      return historySearchText(host, locator, { query: textInput(input, 'query') ?? '', session, limit: limit(DEFAULT_SEARCH_LIMIT) })
    case 'history_read':
      return historyReadText(host, locator, {
        session,
        agent: textInput(input, 'agent'),
        fromLine: countInput(input, 'from_line'),
        toLine: countInput(input, 'to_line'),
        detail: input.detail === 'full' ? 'full' : 'brief',
      })
  }
}
