import type {
  EngineInterface,
  Register,
  SessionCompactInput,
  SessionCompactResult,
  ToolCallResult,
} from 'claude-code'

import {
  BUNDLE_NAME,
  DEFAULT_REMIND_TOKENS,
  NOTE_SLUG_PATTERN,
  agentConcept,
  errorText,
  handoffFolder,
  isRecord,
  noteConcept,
  parsePositive,
  projectKey,
} from './core/common.ts'
import { HISTORY_TOOLS, claudeAgentTranscript, runHistoryTool } from './core/history.ts'
import type { HistoryToolName, Locator } from './core/history.ts'
import { latestUsage, parseItems } from './core/transcript.ts'
import {
  MAX_SEARCH_RESULTS,
  ensureBundle,
  notePath,
  noteText,
  noteTitle,
  readNote,
  searchNotesText,
  utcMinute,
  writeNote,
} from './core/notes.ts'
import type { DirEntry, Host, Store } from './core/notes.ts'
import { ensureOkf, okfFolder } from './core/okf_cli.ts'
import {
  CONTINUE_PROMPT,
  PLUGIN,
  RESET_INSTRUCTIONS,
  SECTION_ID,
  TOOL,
  agentCompactedNotice,
  agentGuidance,
  agentRemainingText,
  guidanceSection,
  handoffMessage,
  heldTurnNotice,
  heldTurnText,
  keptTail,
  latestPrompt,
  parsePlan,
  periodicReminder,
  plannerPrompt,
  recentToolResults,
  remainingText,
  toolId,
  urgentReminder,
} from './handoff'

const OKF_TIMEOUT_MS = 30_000
const GENERATED_BY = `process:${PLUGIN}`
const DEFAULT_MARGIN_PERCENT = 5
/** A note updated within this many tokens of work counts as current. */
const FRESH_TOKENS = 10_000
const RESET_ATTEMPTS = 50
const RESET_RETRY_MS = 200
const DEFAULT_NOTE_SEARCH_LIMIT = 20
const USAGE_TAIL_BYTES = 1_000_000
const USAGE_WIDE_TAIL_BYTES = 16_000_000

/** The handoff bundle and this project's folder of handoff concepts in it. */
type Place = { store: Store; folder: string }

type SessionRecord = {
  /** The context size when the note last changed; absent until the next reading. */
  noteTokens?: number
  remindedTokens?: number
  /** The note version (`writes`) the last urgent reminder was given for. */
  urgedWrites?: number
  writes?: number
  isResetPending?: boolean
  /** The turn a Stop hook kept going after `new_context`, in which no fresh window can start. */
  heldTurnId?: string
  window?: number
}

/** What the mod remembers about one subagent of the session, which keeps a note of its own. */
type AgentRecord = {
  /** The subagent's context size when its note last changed, or when it was first seen. */
  noteTokens?: number
  remindedTokens?: number
  isGuided?: boolean
}

type Limits = { window: number; compactAt: number | undefined }

const NOTE_SCHEMA = {
  type: 'object',
  properties: {
    handoff: {
      type: 'string',
      description: "A handoff slug of this project, as handoff_search gives it; omit it for this session's own note.",
    },
  },
}

const TITLE_PROPERTY = { type: 'string', description: 'A short title for the task; optional.' }

const WRITE_SCHEMA = {
  type: 'object',
  properties: {
    body: { type: 'string', description: 'The whole note in Markdown.' },
    title: TITLE_PROPERTY,
  },
  required: ['body'],
}

const APPEND_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'The Markdown to add.' },
    title: TITLE_PROPERTY,
  },
  required: ['text'],
}

const SEARCH_SCHEMA = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'The text to find.' },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_SEARCH_RESULTS,
      description: `How many matching lines to return; ${DEFAULT_NOTE_SEARCH_LIMIT} by default.`,
    },
  },
  required: ['query'],
}

const HISTORY_TOOL_NAMES = [
  TOOL.historyList,
  TOOL.historySearch,
  TOOL.historyRead,
] as const satisfies readonly HistoryToolName[]

const TOOLS = [
  {
    name: TOOL.read,
    description: "Read this session's handoff note, or another handoff note of this project by its slug.",
    inputSchema: NOTE_SCHEMA,
  },
  {
    name: TOOL.write,
    description:
      "Replace the whole of this session's handoff note, creating it when it does not exist. The note has no fixed layout. Use it to reorganize the note or drop what no longer holds, and before a long or risky step.",
    inputSchema: WRITE_SCHEMA,
  },
  {
    name: TOOL.append,
    description:
      "Add text to the end of this session's handoff note, creating it when it does not exist, without passing the rest of the note again.",
    inputSchema: APPEND_SCHEMA,
  },
  {
    name: TOOL.search,
    description:
      "Find the handoff notes of this project that mention a text, in their titles or bodies, with the matching lines. Read a note it finds by its slug. When the person continues an earlier task, use it to find that task's note and carry what still holds into your own note.",
    inputSchema: SEARCH_SCHEMA,
  },
  {
    name: TOOL.remaining,
    description: 'Report how much of the context window is in use and how many tokens remain before automatic compaction.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: TOOL.newContext,
    description:
      'Start a fresh context window when this turn ends: the conversation is replaced by the handoff note and the work continues on its own. Save the note first. Does not touch files or other environment state.',
    inputSchema: { type: 'object', properties: {} },
  },
  ...HISTORY_TOOL_NAMES.map(name => ({
    name,
    description: HISTORY_TOOLS[name].description,
    inputSchema: { type: 'object', properties: HISTORY_TOOLS[name].properties, required: [...HISTORY_TOOLS[name].required] },
  })),
]

function engineHost($: EngineInterface): Host {
  return {
    async okf(args, stdin) {
      const ran = await $.process.run([runtime.okf, '--format', 'json', ...args], { stdin, timeoutMs: OKF_TIMEOUT_MS })
      if (ran.exitCode !== 0) {
        throw new Error(`okf ${args.join(' ')} failed: ${ran.stderr.trim() || `exit ${ran.exitCode}`}`)
      }

      return ran.stdout.trim() === '' ? undefined : JSON.parse(ran.stdout)
    },
    exists: path => $.fs.exists(path),
    mtimeMs: path => $.fs.stat(path).then(
      stat => stat.mtimeMs,
      () => undefined,
    ),
    async list(path) {
      const entries = await $.fs.list(path).catch(() => [])
      const listed: DirEntry[] = []
      for (const entry of entries) {
        // A link is listed as itself, so what it leads to decides its kind.
        const target = entry.isLink ? await $.fs.stat(`${path}/${entry.name}`).catch(() => undefined) : entry
        listed.push({ name: entry.name, kind: target?.kind ?? 'other', mtimeMs: target?.mtimeMs ?? 0 })
      }

      return listed
    },
    readText: path => $.fs.read(path).catch(() => undefined),
    async lineCount(path) {
      const ran = await $.process.run(['wc', '-l', path], { timeoutMs: OKF_TIMEOUT_MS })
      const count = Number.parseInt(ran.stdout.trim(), 10)
      if (ran.exitCode !== 0 || !Number.isFinite(count)) {
        throw new Error(`cannot count the lines of ${path}: ${ran.stderr.trim() || `exit ${ran.exitCode}`}`)
      }

      return count
    },
    async grep(path, needle, limit) {
      const ran = await $.process.run(['grep', '-n', '-i', '-F', '-m', String(limit), '--', needle, path], {
        timeoutMs: OKF_TIMEOUT_MS,
      })
      // grep exits 1 when nothing matches.
      if (ran.exitCode > 1) {
        throw new Error(`cannot search ${path}: ${ran.stderr.trim() || `exit ${ran.exitCode}`}`)
      }
      const lines = ran.stdout.split('\n')
      // A truncated output ends mid-line, and the final newline leaves an empty piece.
      lines.pop()

      return lines.flatMap(line => {
        const colon = line.indexOf(':')
        const number = Number.parseInt(line.slice(0, colon), 10)

        return colon > 0 && Number.isFinite(number) ? [{ number, text: line.slice(colon + 1) }] : []
      })
    },
    async readLines(path, from, to) {
      const ran = await $.process.run(['sed', '-n', `${from},${to}p;${to}q`, path], { timeoutMs: OKF_TIMEOUT_MS })
      if (ran.exitCode !== 0) {
        throw new Error(`cannot read ${path}: ${ran.stderr.trim() || `exit ${ran.exitCode}`}`)
      }
      const lines = ran.stdout.split('\n')
      // A truncated read ends mid-line, and the final newline leaves an empty piece.
      lines.pop()

      return lines
    },
  }
}

async function claudeDirectory($: EngineInterface): Promise<string> {
  const home = (await $.env.get('HOME'))?.trim() ?? ''
  const configured = (await $.env.get('CLAUDE_CONFIG_DIR'))?.trim()
  if (configured) {
    return configured.startsWith('~/') ? `${home}${configured.slice(1)}` : configured
  }
  if (home === '') {
    throw new Error('HOME is not set')
  }

  return `${home}/.claude`
}

async function handoffPlace($: EngineInterface, isCreating: boolean): Promise<Place | undefined> {
  const store: Store = {
    host: engineHost($),
    root: `${await claudeDirectory($)}/${BUNDLE_NAME}`,
    generatedBy: GENERATED_BY,
  }
  if (!(await $.fs.exists(`${store.root}/index.md`))) {
    if (!isCreating) {
      return undefined
    }
    await ensureBundle(store)
  }

  return { store, folder: handoffFolder(await $.session.root()) }
}

async function sessionKey($: EngineInterface): Promise<string> {
  return `session:${await $.session.id()}`
}

async function sessionRecord($: EngineInterface): Promise<SessionRecord> {
  const stored = await $.store.get(await sessionKey($))

  return isRecord(stored) ? (stored as SessionRecord) : {}
}

async function saveRecord($: EngineInterface, record: SessionRecord): Promise<void> {
  await $.store.set(await sessionKey($), record)
}

async function agentKey($: EngineInterface, agentId: string): Promise<string> {
  return `${await sessionKey($)}:agent:${agentId}`
}

async function agentRecord($: EngineInterface, agentId: string): Promise<AgentRecord> {
  const stored = await $.store.get(await agentKey($, agentId))

  return isRecord(stored) ? (stored as AgentRecord) : {}
}

async function saveAgentRecord($: EngineInterface, agentId: string, record: AgentRecord): Promise<void> {
  await $.store.set(await agentKey($, agentId), record)
}

function agentNote(place: Place, sessionId: string, agentId: string): string {
  return agentConcept(noteConcept(place.folder, sessionId), agentId)
}

/**
 * A subagent's context size from its transcript's last response, since
 * `$.session.usage()` measures the main conversation alone.
 */
async function agentTokens($: EngineInterface, agentId: string): Promise<number | undefined> {
  const path = await claudeAgentTranscript(engineHost($), await transcriptLocator($), agentId)
  if (path === undefined) {
    return undefined
  }
  for (const bytes of [USAGE_TAIL_BYTES, USAGE_WIDE_TAIL_BYTES]) {
    const ran = await $.process.run(['tail', '-c', String(bytes), path], { timeoutMs: OKF_TIMEOUT_MS })
    const usage = ran.exitCode === 0 ? latestUsage(parseItems(ran.stdout.split('\n')), true) : undefined
    if (usage !== undefined) {
      return usage.tokens
    }
  }

  return undefined
}

/** What the hooks share; a reload starts it over, while `$.store` keeps the session record. */
const runtime: {
  limits: Limits | undefined
  guidance: { sessionId: string; text: string } | undefined
  remindTokens: number
  marginPercent: number
  /** The main loop's running turn, which `session.append` does not name. */
  turnId: string | undefined
  /** The okf command, a full path when uv put it off the PATH. */
  okf: string
} = {
  limits: undefined,
  guidance: undefined,
  remindTokens: DEFAULT_REMIND_TOKENS,
  marginPercent: DEFAULT_MARGIN_PERCENT,
  turnId: undefined,
  okf: 'okf',
}

async function setUpOkf($: EngineInterface): Promise<void> {
  const setup = await ensureOkf(
    (argv, timeoutMs) => $.process.run(argv, { timeoutMs }),
    () => $.ui.status('okf handoff: installing okf'),
  ).finally(() => $.ui.status(undefined))
  if ('error' in setup) {
    $.ui.toast(`okf handoff: ${setup.error}, so no handoff note is kept`)

    return
  }
  runtime.okf = setup.path
  if (setup.isInstalled) {
    $.ui.toast(`okf handoff: installed okf at ${setup.path}`)
  }
  if (!setup.isOnPath) {
    // For the agent's shells, and so the okf-wiki skill; the engine's environment is what they inherit.
    await $.env.set('PATH', `${okfFolder(setup.path)}:${(await $.env.get('PATH')) ?? ''}`)
  }
}

function isTurnHeld(record: SessionRecord): boolean {
  return record.heldTurnId !== undefined && record.heldTurnId === runtime.turnId
}

/** The engine's row for a Stop hook's reason to keep the turn going, whatever hook gave it (a command, `/goal`). */
function isStopFeedback(message: { type: string; isMeta?: true; content: readonly unknown[] }): boolean {
  const first = message.content[0]

  return (
    message.type === 'user' &&
    message.isMeta === true &&
    isRecord(first) &&
    first.type === 'text' &&
    typeof first.text === 'string' &&
    first.text.startsWith('Stop hook feedback:')
  )
}

async function refreshLimits($: EngineInterface): Promise<Limits> {
  const { context } = await $.session.usage({ breakdown: 'summary' })
  const breakdown = context.breakdown
  runtime.limits = {
    window: context.window,
    compactAt: breakdown?.isAutoCompactEnabled === true ? breakdown.autoCompactThreshold : undefined,
  }

  return runtime.limits
}

/**
 * Built for the session id the prompt is composed under, the one the tools
 * resolve the note by: `session.start` does not fire on `/clear`, and its id
 * can differ from the transcript's after a reload.
 */
async function guidanceFor($: EngineInterface): Promise<string | undefined> {
  const sessionId = await $.session.id()
  if (runtime.guidance?.sessionId !== sessionId) {
    const place = await handoffPlace($, true)
    if (place === undefined) {
      return undefined
    }
    const text = guidanceSection({ concept: noteConcept(place.folder, sessionId), root: place.store.root })
    runtime.guidance = { sessionId, text }
  }

  return runtime.guidance.text
}

/** The reminder due now, if any: an urgent one near compaction, else a periodic one. */
async function dueReminder($: EngineInterface): Promise<string | undefined> {
  const { context } = await $.session.usage()
  const tokens = context.tokens
  if (tokens === undefined) {
    return undefined
  }
  const record = await sessionRecord($)
  if (record.noteTokens === undefined) {
    // A fresh or just-compacted context starts even with its note.
    await saveRecord($, { ...record, noteTokens: tokens })

    return undefined
  }
  const since = tokens - record.noteTokens
  const current = runtime.limits?.window === context.window ? runtime.limits : await refreshLimits($)
  const writes = record.writes ?? 0
  let text: string | undefined
  if (
    current.compactAt !== undefined &&
    tokens >= current.compactAt - (context.window * runtime.marginPercent) / 100 &&
    record.urgedWrites !== writes
  ) {
    record.urgedWrites = writes
    text = urgentReminder({
      tokens,
      compactAt: current.compactAt,
      isNoteCurrent: record.writes !== undefined && since < FRESH_TOKENS,
      isTurnHeld: isTurnHeld(record),
    })
  } else if (
    since >= runtime.remindTokens &&
    (record.remindedTokens === undefined || tokens - record.remindedTokens >= runtime.remindTokens)
  ) {
    record.remindedTokens = tokens
    text = periodicReminder(since)
  }
  if (text !== undefined) {
    await saveRecord($, record)
  }

  return text
}

/**
 * A subagent's reminder: its first one, once its work has run long, gives it
 * its note. A subagent cannot start a fresh window, so none is urgent.
 */
async function dueAgentReminder($: EngineInterface, agentId: string): Promise<string | undefined> {
  const tokens = await agentTokens($, agentId)
  if (tokens === undefined) {
    return undefined
  }
  const record = await agentRecord($, agentId)
  if (record.noteTokens === undefined) {
    // A subagent is first seen at its first tool call, holding only its task.
    await saveAgentRecord($, agentId, { ...record, noteTokens: tokens })

    return undefined
  }
  const since = tokens - record.noteTokens
  if (
    since < runtime.remindTokens ||
    (record.remindedTokens !== undefined && tokens - record.remindedTokens < runtime.remindTokens)
  ) {
    return undefined
  }
  let text = periodicReminder(since)
  if (record.isGuided !== true) {
    const place = await handoffPlace($, true)
    if (place === undefined) {
      return undefined
    }
    const sessionId = await $.session.id()
    text = agentGuidance({
      concept: agentNote(place, sessionId, agentId),
      root: place.store.root,
      sessionSlug: noteConcept(place.folder, sessionId).slice(place.folder.length + 1),
      agentId,
    })
  }
  await saveAgentRecord($, agentId, { ...record, remindedTokens: tokens, isGuided: true })

  return text
}

async function replaceWithHandoff(
  $: EngineInterface,
  e: SessionCompactInput,
  isReset: boolean,
): Promise<SessionCompactResult> {
  const place = await handoffPlace($, true)
  if (place === undefined) {
    throw new Error('the handoff bundle could not be created')
  }
  const record = await sessionRecord($)
  const concept = noteConcept(place.folder, await $.session.id())
  const note = await readNote(place.store, concept)
  const current = note === undefined ? '' : note.body.trim()
  const { context } = await $.session.usage()
  const since =
    context.tokens !== undefined && record.noteTokens !== undefined
      ? context.tokens - record.noteTokens
      : Number.POSITIVE_INFINITY

  let handoff = current
  let title: string | undefined
  if (current === '' || since >= FRESH_TOKENS) {
    const reply = await $.model.fork({
      prompt: plannerPrompt({
        concept,
        current,
        instructions: isReset ? undefined : e.instructions,
        recentResults: recentToolResults(e.messages),
      }),
    })
    const plan = reply.isAnswered ? parsePlan(reply.text) : undefined
    if (plan !== undefined) {
      handoff = plan.handoff
      title = plan.title
    } else if (current === '') {
      throw new Error(reply.isAnswered ? 'the handoff reply was not a handoff plan' : `the handoff request ended with ${reply.reason}`)
    }
  }

  await writeNote(place.store, concept, { title, body: handoff })
  const window = (record.window ?? 1) + 1
  await saveRecord($, {
    writes: (record.writes ?? 0) + (title === undefined ? 0 : 1),
    window,
    // A compaction inside a held turn leaves it held: its end still does not come.
    heldTurnId: record.heldTurnId,
  })

  const tail = isReset ? [] : keptTail(e.messages)
  const text = handoffMessage({
    root: place.store.root,
    concept,
    handoff,
    prompt: !isReset && tail.length === 0 ? latestPrompt(e.messages) : undefined,
    window,
    isReset,
  })
  $.ui.toast(`okf handoff: context window #${window} starts from ${concept}`)

  return { messages: [{ role: 'user', text, toolUses: [] }, ...tail] }
}

/**
 * Claude Code compacts a subagent as usual; when the subagent keeps a note, one
 * message after the summary tells it the note is there to read.
 */
async function noticeAgentNote(
  $: EngineInterface,
  e: SessionCompactInput,
  agentId: string,
  result: SessionCompactResult,
): Promise<SessionCompactResult> {
  if (result.messages === undefined) {
    return result
  }
  // The baseline is the compacted context, read at the subagent's next tool call.
  await saveAgentRecord($, agentId, { ...(await agentRecord($, agentId)), noteTokens: undefined, remindedTokens: undefined })
  const place = await handoffPlace($, false)
  if (place === undefined) {
    return result
  }
  const concept = agentNote(place, await $.session.id(), agentId)
  const modifiedMs = await place.store.host.mtimeMs(notePath(place.store, concept))
  if (modifiedMs === undefined) {
    return result
  }
  const before = new Set(e.messages.map(message => message.handle))
  // The summary is the message the compaction made, ahead of the ones it kept.
  const summary = result.messages.findIndex(message => message.handle === undefined || !before.has(message.handle))
  const at = (summary === -1 ? 0 : summary) + 1
  const text = agentCompactedNotice({ concept, modified: utcMinute(modifiedMs), agentId })

  return {
    ...result,
    messages: [...result.messages.slice(0, at), { role: 'user', text, toolUses: [] }, ...result.messages.slice(at)],
  }
}

/** Resets the context once the turn that asked for it has let go of the session. */
async function resetContext($: EngineInterface): Promise<void> {
  for (let attempt = 0; attempt < RESET_ATTEMPTS; attempt += 1) {
    if ((await sessionRecord($)).isResetPending !== true) {
      // A compaction or a held turn took the request back.
      return
    }
    try {
      await $.command.run({ command: 'compact', args: RESET_INSTRUCTIONS })
    } catch {
      // The command is refused while the turn that asked for the reset still runs.
      await $.clock.sleep(RESET_RETRY_MS)
      continue
    }
    if ((await sessionRecord($)).isResetPending === true) {
      // The compaction hook clears the flag; still set, the conversation was not replaced.
      $.ui.toast('okf handoff: new_context did not replace the conversation')
      await saveRecord($, { ...(await sessionRecord($)), isResetPending: false })

      return
    }
    await $.prompt.submit({ text: CONTINUE_PROMPT })

    return
  }
  $.ui.toast('okf handoff: new_context could not start a fresh context window')
  await saveRecord($, { ...(await sessionRecord($)), isResetPending: false })
}

/** The caller's own note: the session's for the main agent, a subagent's its own. */
async function ownConcept($: EngineInterface, place: Place, agentId: string | undefined): Promise<string> {
  const sessionId = await $.session.id()

  return agentId === undefined ? noteConcept(place.folder, sessionId) : agentNote(place, sessionId, agentId)
}

/** The note a tool names by its `handoff` slug, or the caller's own; a string when the input is unusable. */
async function namedConcept(
  $: EngineInterface,
  place: Place,
  input: Record<string, unknown>,
  agentId: string | undefined,
): Promise<{ concept: string } | string> {
  const slug = typeof input.handoff === 'string' && input.handoff !== '' ? input.handoff : undefined
  if (slug !== undefined && !NOTE_SLUG_PATTERN.test(slug)) {
    return 'Pass "handoff" as a slug that handoff_search gave.'
  }

  return { concept: slug === undefined ? await ownConcept($, place, agentId) : `${place.folder}/${slug}` }
}

async function readTool($: EngineInterface, input: Record<string, unknown>, agentId: string | undefined): Promise<string> {
  const place = await handoffPlace($, false)
  if (place === undefined) {
    return 'No handoff note has been written on this machine yet.'
  }
  const named = await namedConcept($, place, input, agentId)

  return typeof named === 'string' ? named : noteText(place.store, named.concept)
}

/** Writes or appends to the caller's own note and counts it as the note's latest version. */
async function saveTool(
  $: EngineInterface,
  input: Record<string, unknown>,
  options: { field: 'body' | 'text'; isAppend: boolean; agentId: string | undefined },
): Promise<string> {
  const body = typeof input[options.field] === 'string' ? (input[options.field] as string).trim() : ''
  if (body === '') {
    return options.isAppend ? 'Pass "text" as the Markdown to add.' : 'Pass "body" as the whole note in Markdown.'
  }
  const title = typeof input.title === 'string' && input.title.trim() !== '' ? input.title.trim() : undefined
  const place = await handoffPlace($, true)
  if (place === undefined) {
    throw new Error('the handoff bundle could not be created')
  }
  const { agentId } = options
  const concept = await ownConcept($, place, agentId)
  await writeNote(place.store, concept, { title, body, append: options.isAppend })
  if (agentId === undefined) {
    const record = await sessionRecord($)
    const { context } = await $.session.usage()
    await saveRecord($, {
      ...record,
      writes: (record.writes ?? 0) + 1,
      noteTokens: context.tokens,
      remindedTokens: undefined,
    })
  } else {
    const record = await agentRecord($, agentId)
    await saveAgentRecord($, agentId, {
      ...record,
      // A subagent that keeps its note unprompted needs no guidance later.
      isGuided: true,
      noteTokens: (await agentTokens($, agentId)) ?? record.noteTokens,
      remindedTokens: undefined,
    })
  }

  return `${options.isAppend ? 'Appended to' : 'Saved'} ${concept}.`
}

async function searchTool($: EngineInterface, input: Record<string, unknown>): Promise<string> {
  const query = typeof input.query === 'string' ? input.query.trim() : ''
  if (query === '') {
    return 'Pass "query" as the text to find.'
  }
  const place = await handoffPlace($, false)
  if (place === undefined) {
    return 'No handoff note has been written on this machine yet.'
  }
  const limit = typeof input.limit === 'number' && Number.isInteger(input.limit) && input.limit > 0 ? input.limit : DEFAULT_NOTE_SEARCH_LIMIT

  return searchNotesText(place.store, place.folder, query, Math.min(limit, MAX_SEARCH_RESULTS))
}

async function remainingTool($: EngineInterface, agentId: string | undefined): Promise<string> {
  if (agentId !== undefined) {
    return agentRemainingText(await agentTokens($, agentId))
  }
  const current = await refreshLimits($)
  const { context } = await $.session.usage()

  return remainingText({ tokens: context.tokens, window: current.window, compactAt: current.compactAt })
}

async function transcriptLocator($: EngineInterface): Promise<Locator> {
  return {
    kind: 'claude',
    root: `${await claudeDirectory($)}/projects`,
    key: projectKey(await $.session.root()),
    sessionId: await $.session.id(),
  }
}

async function historyTool($: EngineInterface, name: HistoryToolName, input: Record<string, unknown>): Promise<string> {
  const locator = await transcriptLocator($)
  const place = await handoffPlace($, false)
  const titleOf = (sessionId: string) =>
    place === undefined ? Promise.resolve('') : noteTitle(place.store, noteConcept(place.folder, sessionId))

  return runHistoryTool(name, engineHost($), locator, input, titleOf)
}

function saveResult(
  $: EngineInterface,
  e: object,
  options: { field: 'body' | 'text'; isAppend: boolean; agentId: string | undefined },
): Promise<string> {
  const tool = options.isAppend ? TOOL.append : TOOL.write

  return saveTool($, e as Record<string, unknown>, options).catch((error: unknown) => `${tool} failed: ${errorText(error)}`)
}

function historyResult($: EngineInterface, name: HistoryToolName, e: object): Promise<string> {
  return historyTool($, name, e as Record<string, unknown>).catch((error: unknown) => `${name} failed: ${errorText(error)}`)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    for (const tool of TOOLS) {
      await $.tool.register({ ...tool, isDeferred: false })
    }
    runtime.remindTokens = parsePositive(await $.env.get('OKF_HANDOFF_REMIND_TOKENS'), DEFAULT_REMIND_TOKENS)
    const margin = parsePositive(await $.env.get('OKF_HANDOFF_MARGIN_PERCENT'), DEFAULT_MARGIN_PERCENT)
    runtime.marginPercent = margin < 100 ? margin : DEFAULT_MARGIN_PERCENT
    await setUpOkf($)
    try {
      const record = await sessionRecord($)
      if (record.isResetPending === true) {
        // A reset asked for by a process that exited before its turn ended is not carried over.
        await saveRecord($, { ...record, isResetPending: false })
      }
    } catch (error) {
      $.ui.toast(`okf handoff: the session record could not be read: ${errorText(error)}`)
    }

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    const text = await guidanceFor($).catch((error: unknown) => {
      $.ui.toast(`okf handoff: no handoff note this session: ${errorText(error)}`)

      return undefined
    })

    return text === undefined
      ? result
      : { sections: [...result.sections, { id: SECTION_ID, text, scope: 'session' as const }] }
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context') && runtime.limits?.window !== e.context.window) {
      await refreshLimits($).catch(() => undefined)
    }

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command !== undefined || (e.origin.kind === 'plugin' && e.origin.name === PLUGIN)) {
      return next(e)
    }
    const text = await dueReminder($).catch(() => undefined)

    return next(text === undefined ? e : { ...e, context: [...(e.context ?? []), text] })
  })

  // Reminders ride on the results of an agent's other tools, as a PostToolUse hook's context does.
  on('tool.call', async ($, e, next) => {
    const result: ToolCallResult = await next(e)
    if (e.tool.startsWith(toolId('')) || result.deny !== undefined) {
      return result
    }
    const due = e.agentId === undefined ? dueReminder($) : dueAgentReminder($, e.agentId)
    const text = await due.catch(() => undefined)

    return text === undefined ? result : { ...result, context: [...(result.context ?? []), text] }
  })

  on('tool.call', { tool: toolId(TOOL.read) }, async ($, e) => ({
    result: await readTool($, e as unknown as Record<string, unknown>, e.agentId).catch(
      (error: unknown) => `handoff_read failed: ${errorText(error)}`,
    ),
  }))
  on('tool.call', { tool: toolId(TOOL.write) }, async ($, e) => ({
    result: await saveResult($, e, { field: 'body', isAppend: false, agentId: e.agentId }),
  }))
  on('tool.call', { tool: toolId(TOOL.append) }, async ($, e) => ({
    result: await saveResult($, e, { field: 'text', isAppend: true, agentId: e.agentId }),
  }))
  on('tool.call', { tool: toolId(TOOL.search) }, async ($, e) => ({
    result: await searchTool($, e as unknown as Record<string, unknown>).catch(
      (error: unknown) => `${TOOL.search} failed: ${errorText(error)}`,
    ),
  }))
  on('tool.call', { tool: toolId(TOOL.remaining) }, async ($, e) => ({
    result: await remainingTool($, e.agentId).catch((error: unknown) => `context_remaining failed: ${errorText(error)}`),
  }))
  on('tool.call', { tool: toolId(TOOL.newContext) }, async ($, e) => {
    if (e.agentId !== undefined) {
      return {
        deny: 'A subagent cannot start a fresh context window. Keep your handoff note current instead: when your context fills up, Claude Code compacts it as usual and you are told the note is there.',
      }
    }
    const record = await sessionRecord($)
    if (isTurnHeld(record)) {
      return { result: heldTurnText() }
    }
    await saveRecord($, { ...record, isResetPending: true })

    return {
      result:
        'A fresh context window starts when this turn ends: the conversation is replaced by the handoff note, and the work continues on its own. If the note is behind the work, update it with handoff_write first. Then end the turn with a one-line status.',
    }
  })
  on('tool.call', { tool: toolId(TOOL.historyList) }, async ($, e) => ({
    result: await historyResult($, TOOL.historyList, e),
  }))
  on('tool.call', { tool: toolId(TOOL.historySearch) }, async ($, e) => ({
    result: await historyResult($, TOOL.historySearch, e),
  }))
  on('tool.call', { tool: toolId(TOOL.historyRead) }, async ($, e) => ({
    result: await historyResult($, TOOL.historyRead, e),
  }))

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      runtime.turnId = e.turnId
    }

    return next(e)
  })

  // A Stop hook that keeps the turn going leaves new_context waiting for an end that does not come.
  on('session.append', { door: 'note' }, async ($, e, next) => {
    if (e.agentId !== undefined || runtime.turnId === undefined || !isStopFeedback(e.message)) {
      return next(e)
    }
    const record = await sessionRecord($).catch(() => undefined)
    if (record?.isResetPending !== true) {
      return next(e)
    }
    await saveRecord($, { ...record, isResetPending: false, heldTurnId: runtime.turnId })
    const content = [...e.message.content]
    const last = content.findLastIndex(block => block.type === 'text')
    const block = content[last]
    if (block === undefined || block.type !== 'text') {
      return next(e)
    }
    content[last] = { ...block, text: `${block.text}\n\n${heldTurnNotice()}` }

    return next({ ...e, message: { ...e.message, content } })
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) {
      return result
    }
    let record = await sessionRecord($)
    if (record.heldTurnId !== undefined) {
      record = { ...record, heldTurnId: undefined }
      await saveRecord($, record)
    }
    if (record.isResetPending === true) {
      if (e.isAborted) {
        await saveRecord($, { ...record, isResetPending: false })
        $.ui.toast('okf handoff: the turn was interrupted, so new_context was cancelled')
      } else {
        // A timer outlives this dispatch, and the session only compacts between turns.
        $.clock.after(0, () => {
          void resetContext($)
        })
      }
    }

    return result
  })

  on('session.compact', async ($, e, next) => {
    const { agentId } = e
    if (agentId !== undefined) {
      const result = await next(e)
      // A precomputed summary installs nothing; the compaction that uses it is noticed instead.
      if (e.trigger === 'precompute') {
        return result
      }

      return noticeAgentNote($, e, agentId, result).catch((error: unknown) => {
        $.ui.toast(`okf handoff: a subagent was not told about its note: ${errorText(error)}`)

        return result
      })
    }
    // The note is written when the compaction runs, so a precomputed summary would be wasted.
    if (e.trigger === 'precompute') {
      return { skip: `${PLUGIN} writes a handoff note when the compaction runs` }
    }
    // The plugin's own `$.session.compact` would skip this hook as a re-entry, so a reset arrives
    // as the `/compact` command the plugin ran, marked by its instructions.
    const isReset =
      e.instructions?.trim() === RESET_INSTRUCTIONS && (await sessionRecord($)).isResetPending === true
    $.ui.status('okf handoff: writing')
    try {
      return await replaceWithHandoff($, e, isReset)
    } catch (error) {
      $.ui.toast(`okf handoff failed, compacting as usual: ${errorText(error)}`)
      if (isReset) {
        await saveRecord($, { ...(await sessionRecord($)), isResetPending: false })
      }

      return next(e)
    } finally {
      $.ui.status(undefined)
    }
  })
}
