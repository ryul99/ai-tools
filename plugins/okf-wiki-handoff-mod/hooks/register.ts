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
  SLUG_PATTERN,
  errorText,
  handoffFolder,
  isRecord,
  noteConcept,
  parsePositive,
} from './core/common.ts'
import { ensureBundle, nextSegment, noteText, readNote, recentNotes, segmentsOf, writeNote } from './core/notes.ts'
import type { Host, Store } from './core/notes.ts'
import { recallText } from './core/transcript.ts'
import {
  CONTINUE_PROMPT,
  PLUGIN,
  RESET_INSTRUCTIONS,
  SECTION_ID,
  TOOL,
  guidanceSection,
  handoffMessage,
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
const DESCRIPTION = 'Handoff note an agent keeps current so its session survives context resets and compaction.'
const DEFAULT_MARGIN_PERCENT = 5
/** A note updated within this many tokens of work counts as current. */
const FRESH_TOKENS = 10_000
const RESET_ATTEMPTS = 50
const RESET_RETRY_MS = 200

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
  window?: number
}

type Limits = { window: number; compactAt: number | undefined }

const NOTE_SCHEMA = {
  type: 'object',
  properties: {
    handoff: {
      type: 'string',
      description: "A handoff slug of this project, from the session's list; omit it for this session's own note.",
    },
  },
}

const WRITE_SCHEMA = {
  type: 'object',
  properties: {
    body: { type: 'string', description: 'The whole note in Markdown.' },
    title: { type: 'string', description: 'A short title for the task; optional.' },
  },
  required: ['body'],
}

const RECALL_SCHEMA = {
  type: 'object',
  properties: {
    segment: { type: 'integer', minimum: 1, description: 'The archived segment number.' },
    handoff: {
      type: 'string',
      description: "The handoff slug in this project; defaults to this session's note.",
    },
    from_line: {
      type: 'integer',
      minimum: 1,
      description: 'The transcript line to continue from, as a previous call reported.',
    },
  },
  required: ['segment'],
}

const TOOLS = [
  {
    name: TOOL.read,
    description: "Read this session's handoff note, or another handoff note of this project by its slug.",
    inputSchema: NOTE_SCHEMA,
  },
  {
    name: TOOL.write,
    description:
      "Replace this session's handoff note, creating it when it does not exist. Pass the whole note with the sections # Goal, # State, # Decisions and constraints, # Next steps and # Open questions; the plugin keeps the archived segments.",
    inputSchema: WRITE_SCHEMA,
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
  {
    name: TOOL.recall,
    description:
      'Read the original messages of a conversation segment that a context reset or compaction replaced. Use it when the handoff note lacks a detail you need, such as an exact command, error message or file content.',
    inputSchema: RECALL_SCHEMA,
  },
]

function engineHost($: EngineInterface): Host {
  return {
    async okf(args, stdin) {
      const ran = await $.process.run(['okf', '--format', 'json', ...args], { stdin, timeoutMs: OKF_TIMEOUT_MS })
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
    description: DESCRIPTION,
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

async function lineCount($: EngineInterface, path: string): Promise<number | undefined> {
  const ran = await $.process.run(['wc', '-l', path], { timeoutMs: OKF_TIMEOUT_MS })
  const count = Number.parseInt(ran.stdout.trim(), 10)

  return ran.exitCode === 0 && Number.isFinite(count) ? count : undefined
}

/**
 * A mod installed or reloaded mid-session has seen no classic event before its
 * first compaction, so the transcript is then found by the session's id, which
 * names the file in one of the `projects/` folders.
 */
async function transcriptPath(
  $: EngineInterface,
  captured: string | undefined,
): Promise<string | undefined> {
  if (captured !== undefined) {
    return captured
  }
  const projects = `${await claudeDirectory($)}/projects`
  if (!(await $.fs.exists(projects))) {
    return undefined
  }
  const name = `${await $.session.id()}.jsonl`
  for (const entry of await $.fs.list(projects)) {
    const path = `${projects}/${entry.name}/${name}`
    if (entry.kind === 'dir' && (await $.fs.exists(path))) {
      return path
    }
  }

  return undefined
}

/** What the hooks share; a reload starts it over, while `$.store` keeps the session record. */
const runtime: {
  transcript: string | undefined
  limits: Limits | undefined
  guidance: { sessionId: string; text: string } | undefined
  remindTokens: number
  marginPercent: number
} = {
  transcript: undefined,
  limits: undefined,
  guidance: undefined,
  remindTokens: DEFAULT_REMIND_TOKENS,
  marginPercent: DEFAULT_MARGIN_PERCENT,
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
    const concept = noteConcept(place.folder, sessionId)
    const recent = await recentNotes(place.store, place.folder, concept)
    const text = guidanceSection({ concept, root: place.store.root, recent })
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

  const segments = await segmentsOf(place.store, concept)
  const path = await transcriptPath($, runtime.transcript)
  const lastLine = path === undefined ? undefined : await lineCount($, path)
  const segment =
    path === undefined || lastLine === undefined
      ? undefined
      : nextSegment(segments, path, lastLine, new Date().toISOString())
  if (segment !== undefined) {
    segments.push(segment)
  }

  await writeNote(place.store, concept, {
    title,
    body: handoff,
    segments: segment === undefined ? undefined : segments,
  })
  const window = (record.window ?? 1) + 1
  await saveRecord($, {
    writes: (record.writes ?? 0) + (title === undefined ? 0 : 1),
    window,
  })

  const tail = isReset ? [] : keptTail(e.messages)
  const text = handoffMessage({
    root: place.store.root,
    concept,
    handoff,
    prompt: !isReset && tail.length === 0 ? latestPrompt(e.messages) : undefined,
    segments: segments.length,
    window,
    isReset,
  })
  $.ui.toast(`okf handoff: context window #${window} starts from ${concept}`)

  return { messages: [{ role: 'user', text, toolUses: [] }, ...tail] }
}

/** Resets the context once the turn that asked for it has let go of the session. */
async function resetContext($: EngineInterface): Promise<void> {
  for (let attempt = 0; attempt < RESET_ATTEMPTS; attempt += 1) {
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

/** The note a tool names by its `handoff` slug, or this session's own; a string when the input is unusable. */
async function namedConcept(
  $: EngineInterface,
  place: Place,
  input: Record<string, unknown>,
): Promise<{ concept: string } | string> {
  const slug = typeof input.handoff === 'string' && input.handoff !== '' ? input.handoff : undefined
  if (slug !== undefined && !SLUG_PATTERN.test(slug)) {
    return 'Pass "handoff" as a slug from the list of recent notes.'
  }

  return { concept: slug === undefined ? noteConcept(place.folder, await $.session.id()) : `${place.folder}/${slug}` }
}

async function readTool($: EngineInterface, input: Record<string, unknown>): Promise<string> {
  const place = await handoffPlace($, false)
  if (place === undefined) {
    return 'No handoff note has been written on this machine yet.'
  }
  const named = await namedConcept($, place, input)

  return typeof named === 'string' ? named : noteText(place.store, named.concept)
}

async function writeTool($: EngineInterface, input: Record<string, unknown>): Promise<string> {
  const body = typeof input.body === 'string' ? input.body.trim() : ''
  if (body === '') {
    return 'Pass "body" as the whole note in Markdown.'
  }
  const title = typeof input.title === 'string' && input.title.trim() !== '' ? input.title.trim() : undefined
  const place = await handoffPlace($, true)
  if (place === undefined) {
    throw new Error('the handoff bundle could not be created')
  }
  const record = await sessionRecord($)
  const concept = noteConcept(place.folder, await $.session.id())
  await writeNote(place.store, concept, { title, body })
  const { context } = await $.session.usage()
  await saveRecord($, {
    ...record,
    writes: (record.writes ?? 0) + 1,
    noteTokens: context.tokens,
    remindedTokens: undefined,
  })

  return `Saved ${concept}.`
}

async function remainingTool($: EngineInterface): Promise<string> {
  const current = await refreshLimits($)
  const { context } = await $.session.usage()

  return remainingText({ tokens: context.tokens, window: current.window, compactAt: current.compactAt })
}

async function recallTool($: EngineInterface, input: Record<string, unknown>): Promise<string> {
  const number = input.segment
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) {
    return 'Pass "segment" as a positive integer.'
  }
  const place = await handoffPlace($, false)
  if (place === undefined) {
    return 'No handoff note has been written on this machine yet.'
  }
  const named = await namedConcept($, place, input)
  if (typeof named === 'string') {
    return named
  }
  const fromLine = typeof input.from_line === 'number' && Number.isInteger(input.from_line) ? input.from_line : undefined

  return recallText(place.store, named.concept, number, fromLine)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    for (const tool of TOOLS) {
      await $.tool.register({ ...tool, isDeferred: false })
    }
    runtime.remindTokens = parsePositive(await $.env.get('OKF_HANDOFF_REMIND_TOKENS'), DEFAULT_REMIND_TOKENS)
    const margin = parsePositive(await $.env.get('OKF_HANDOFF_MARGIN_PERCENT'), DEFAULT_MARGIN_PERCENT)
    runtime.marginPercent = margin < 100 ? margin : DEFAULT_MARGIN_PERCENT
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

  // Classic events carry the transcript path, which the archive points into.
  on('classic.SessionStart', ($, e, next) => {
    runtime.transcript = e.transcript_path || runtime.transcript

    return next(e)
  })
  on('classic.UserPromptSubmit', ($, e, next) => {
    runtime.transcript = e.transcript_path || runtime.transcript

    return next(e)
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

  // Reminders ride on the results of the main agent's other tools, as a PostToolUse hook's context does.
  on('tool.call', async ($, e, next) => {
    const result: ToolCallResult = await next(e)
    if (e.agentId !== undefined || e.tool.startsWith(toolId('')) || result.deny !== undefined) {
      return result
    }
    const text = await dueReminder($).catch(() => undefined)

    return text === undefined ? result : { ...result, context: [...(result.context ?? []), text] }
  })

  const mainOnly = 'Only the main agent keeps the handoff note.'
  on('tool.call', { tool: toolId(TOOL.read) }, async ($, e) => ({
    result: await readTool($, e as unknown as Record<string, unknown>).catch(
      (error: unknown) => `handoff_read failed: ${errorText(error)}`,
    ),
  }))
  on('tool.call', { tool: toolId(TOOL.write) }, async ($, e) =>
    e.agentId !== undefined
      ? { deny: mainOnly }
      : {
          result: await writeTool($, e as unknown as Record<string, unknown>).catch(
            (error: unknown) => `handoff_write failed: ${errorText(error)}`,
          ),
        },
  )
  on('tool.call', { tool: toolId(TOOL.remaining) }, async $ => ({
    result: await remainingTool($).catch((error: unknown) => `context_remaining failed: ${errorText(error)}`),
  }))
  on('tool.call', { tool: toolId(TOOL.newContext) }, async ($, e) => {
    if (e.agentId !== undefined) {
      return { deny: mainOnly }
    }
    await saveRecord($, { ...(await sessionRecord($)), isResetPending: true })

    return {
      result:
        'A fresh context window starts when this turn ends: the conversation is replaced by the handoff note, and the work continues on its own. If the note is behind the work, update it with handoff_write first. Then end the turn with a one-line status.',
    }
  })
  on('tool.call', { tool: toolId(TOOL.recall) }, async ($, e) => ({
    result: await recallTool($, e as unknown as Record<string, unknown>).catch(
      (error: unknown) => `recall failed: ${errorText(error)}`,
    ),
  }))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) {
      return result
    }
    const record = await sessionRecord($)
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
    if (e.agentId !== undefined) {
      return next(e)
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
