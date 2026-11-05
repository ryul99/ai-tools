// Hooks and MCP server of okf-wiki-handoff.
//
// The hooks keep the agent writing a per-session OKF handoff note and bring that
// note back after a context compaction. The MCP server gives the agent the tools
// to read and write the note and to recall archived transcript segments.

import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { access, constants, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as sleep } from 'node:timers/promises'

import {
  BUNDLE_NAME,
  DEFAULT_REMIND_TOKENS,
  MARKER,
  errorText,
  handoffFolder,
  isRecord,
  noteConcept,
  parsePositive,
} from '../lib/core/common.ts'
import { nextSegment, notePath, noteText, readNote, recentNotes, segmentsOf, writeNote } from '../lib/core/notes.ts'
import type { Host, RecentNote, Store } from '../lib/core/notes.ts'
import { recallText } from '../lib/core/transcript.ts'

const VERSION = '0.2.0'
const SERVER_NAME = 'okf-handoff'
const GENERATED_BY = 'process:okf-wiki-handoff'
const DESCRIPTION = 'Handoff note an agent keeps current so its session survives context compaction.'
const NOTE_PATTERN = /^handoff\/[A-Za-z0-9-]+\/[a-z0-9][a-z0-9-]{0,63}$/
const SESSION_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

const OKF_TIMEOUT_MS = 30_000
const USAGE_TAIL_BYTES = 1_000_000
const USAGE_WIDE_TAIL_BYTES = 16_000_000
const MAX_INJECTED_NOTE_CHARS = 20_000
const LOCK_WAIT_MS = 20_000
const LOCK_STALE_MS = 60_000

const NOTE_SECTIONS = `- "# Goal": what the person asked for and what finished looks like.
- "# State": what is done and what is in progress, with exact file paths, branches, commands, identifiers, and changes not committed yet.
- "# Decisions and constraints": rules the person set and decisions already made. Keep a rule's own wording where it matters; never soften a constraint. Leave out what the system prompt and instruction files already say.
- "# Next steps": the concrete next actions, in order.
- "# Open questions": what is unresolved or waiting on the person, or "None." when nothing is.`

type Usage = { id: string; tokens: number }

/** What the hooks remember about a session between events, in the plugin data directory. */
type State = {
  note?: string
  guided?: boolean
  rebase?: boolean
  note_mtime?: number | null
  note_tokens?: number | null
  reminded_tokens?: number | null
  archived_marker?: string
  stale_usage?: string | null
}

type HookOutput = Record<string, unknown>

// ---------------------------------------------------------------------------
// Runtime

function nowIso(): string {
  return `${new Date().toISOString().slice(0, 19)}Z`
}

function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? `${homedir()}${path.slice(1)}` : path
}

/** The reminder interval from OKF_HANDOFF_REMIND_TOKENS, such as 25000 or 25k. */
function remindTokens(): number {
  return Math.trunc(parsePositive(process.env.OKF_HANDOFF_REMIND_TOKENS, DEFAULT_REMIND_TOKENS)) || DEFAULT_REMIND_TOKENS
}

function hostName(): 'claude' | 'codex' {
  const configured = (process.env.OKF_HANDOFF_CLI ?? '').trim().toLowerCase()
  if (configured === 'claude' || configured === 'codex') {
    return configured
  }

  return process.env.PLUGIN_ROOT ? 'codex' : 'claude'
}

function bundleRoot(host: 'claude' | 'codex'): string {
  const variable = host === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'
  const configured = (process.env[variable] ?? '').trim()
  const directory = configured === '' ? join(homedir(), host === 'codex' ? '.codex' : '.claude') : expandHome(configured)

  return join(directory, BUNDLE_NAME)
}

async function onPath(command: string): Promise<string | undefined> {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (directory === '') {
      continue
    }
    const candidate = join(directory, command)
    try {
      await access(candidate, constants.X_OK)
      if ((await stat(candidate)).isFile()) {
        return candidate
      }
    } catch {
      // Not in this directory.
    }
  }

  return undefined
}

function run(
  argv: readonly string[],
  options: { cwd?: string; stdin?: string },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const [command, ...args] = argv
    if (command === undefined) {
      reject(new Error('no command to run'))

      return
    }
    const child = spawn(command, args, { cwd: options.cwd, timeout: OKF_TIMEOUT_MS, stdio: 'pipe' })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', reject)
    child.on('close', (code, signal) => {
      resolve({
        exitCode: code ?? (signal === null ? 1 : 128),
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    })
    child.stdin.end(options.stdin ?? '')
  })
}

async function isDirectory(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined))?.isDirectory() === true
}

async function isFile(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined))?.isFile() === true
}

async function* fileLines(path: string): AsyncGenerator<string> {
  const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Number.POSITIVE_INFINITY })
  try {
    yield* lines
  } finally {
    lines.close()
  }
}

const nodeHost: Host = {
  async okf(args, stdin) {
    const executable = await onPath('okf')
    if (executable === undefined) {
      throw new Error('okf command is not available')
    }
    const rootIndex = args.indexOf('--root')
    const root = rootIndex === -1 ? undefined : args[rootIndex + 1]
    const ran = await run([executable, '--format', 'json', ...args], {
      cwd: root !== undefined && (await isDirectory(root)) ? root : undefined,
      stdin,
    })
    if (ran.exitCode !== 0) {
      const detail = ran.stderr.trim() || ran.stdout.trim() || `exit ${ran.exitCode}`
      const command = args.slice(rootIndex === -1 ? 0 : 2, (rootIndex === -1 ? 0 : 2) + 2).join(' ')
      throw new Error(`okf ${command} failed: ${detail}`)
    }
    if (ran.stdout.trim() === '') {
      return undefined
    }
    try {
      return JSON.parse(ran.stdout)
    } catch {
      throw new Error('okf returned invalid JSON')
    }
  },
  exists: async path => (await stat(path).catch(() => undefined)) !== undefined,
  mtimeMs: async path => (await stat(path).catch(() => undefined))?.mtimeMs,
  async readLines(path, from, to) {
    const lines: string[] = []
    let number = 0
    for await (const line of fileLines(path)) {
      number += 1
      if (number > to) {
        break
      }
      if (number >= from) {
        lines.push(line)
      }
    }

    return lines
  },
}

function storeAt(root: string): Store {
  return { host: nodeHost, root, description: DESCRIPTION, generatedBy: GENERATED_BY }
}

// ---------------------------------------------------------------------------
// Transcripts

async function tailItems(path: string, limit: number): Promise<Record<string, unknown>[]> {
  let raw: Buffer
  try {
    const file = await open(path, 'r')
    try {
      const { size } = await file.stat()
      const start = Math.max(size - limit, 0)
      raw = Buffer.alloc(size - start)
      await file.read(raw, 0, raw.length, start)
      if (start > 0) {
        // The first line is cut short.
        const newline = raw.indexOf(0x0a)
        raw = newline === -1 ? Buffer.alloc(0) : raw.subarray(newline + 1)
      }
    } finally {
      await file.close()
    }
  } catch {
    return []
  }
  const items: Record<string, unknown>[] = []
  for (const line of raw.toString('utf8').split('\n')) {
    try {
      const item: unknown = JSON.parse(line)
      if (isRecord(item)) {
        items.push(item)
      }
    } catch {
      // Not a whole JSON line.
    }
  }

  return items
}

/** The newest context size the transcript reports: Claude Code's last main-chain assistant usage, or Codex's last token count. */
function latestUsage(items: readonly Record<string, unknown>[]): Usage | undefined {
  for (const item of [...items].reverse()) {
    const message = item.message
    if (item.type === 'assistant' && isRecord(message) && !item.isSidechain) {
      const usage = message.usage
      if (!isRecord(usage)) {
        continue
      }
      const tokens = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']
        .map(key => usage[key])
        .reduce<number>((total, count) => total + (Number.isInteger(count) ? (count as number) : 0), 0)
      if (tokens > 0) {
        return { id: String(item.uuid || item.timestamp || ''), tokens }
      }
      continue
    }
    const payload = item.payload
    if (item.type === 'event_msg' && isRecord(payload) && payload.type === 'token_count') {
      const info = payload.info
      const last = isRecord(info) ? info.last_token_usage : undefined
      const tokens = isRecord(last) ? last.total_tokens : undefined
      if (typeof tokens === 'number' && Number.isInteger(tokens) && tokens > 0) {
        return { id: `${item.timestamp}#${item.ordinal}`, tokens }
      }
    }
  }

  return undefined
}

async function transcriptUsage(path: unknown): Promise<Usage | undefined> {
  if (typeof path !== 'string' || path === '') {
    return undefined
  }
  const file = expandHome(path)

  return latestUsage(await tailItems(file, USAGE_TAIL_BYTES)) ?? latestUsage(await tailItems(file, USAGE_WIDE_TAIL_BYTES))
}

async function lineCount(path: string): Promise<number> {
  let count = 0
  for await (const chunk of createReadStream(path)) {
    for (const byte of chunk as Buffer) {
      if (byte === 0x0a) {
        count += 1
      }
    }
  }

  return count
}

/** Identifies the newest compaction recorded in the transcript: Claude Code's compact boundary or Codex's compacted item. */
async function compactionMarker(transcript: string): Promise<string | undefined> {
  for (const item of (await tailItems(transcript, USAGE_TAIL_BYTES)).reverse()) {
    const payload = item.payload
    if (
      (item.type === 'system' && item.subtype === 'compact_boundary') ||
      item.type === 'compacted' ||
      (item.type === 'event_msg' && isRecord(payload) && payload.type === 'context_compacted')
    ) {
      return String(item.uuid || `${item.timestamp}#${item.ordinal}`)
    }
  }

  return undefined
}

// ---------------------------------------------------------------------------
// Session state

function statePath(dataDir: string, sessionId: string): string {
  return join(dataDir, 'sessions', `${sessionId}.json`)
}

async function loadState(dataDir: string, sessionId: string): Promise<State> {
  try {
    const state: unknown = JSON.parse(await readFile(statePath(dataDir, sessionId), 'utf8'))

    return isRecord(state) ? (state as State) : {}
  } catch {
    return {}
  }
}

async function saveState(dataDir: string, sessionId: string, state: State): Promise<void> {
  const path = statePath(dataDir, sessionId)
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(state), 'utf8')
  await rename(temporary, path)
}

/** The note file's modification time in seconds, as the state records it. */
async function noteMtime(store: Store, concept: string): Promise<number | null> {
  const mtimeMs = await store.host.mtimeMs(notePath(store, concept))

  return mtimeMs === undefined ? null : mtimeMs / 1000
}

/**
 * Updates the state from the transcript and the note file and returns the
 * current context size, or `undefined` while only pre-compaction usage is known.
 */
async function observe(state: State, store: Store, usage: Usage | undefined): Promise<number | undefined> {
  let tokens = usage?.tokens
  if (usage !== undefined && usage.id !== '' && usage.id === state.stale_usage) {
    tokens = undefined
  }
  const modified = await noteMtime(store, state.note ?? '')
  if (modified !== (state.note_mtime ?? null)) {
    // The agent rewrote the note since the last hook looked at it.
    state.note_mtime = modified
    state.note_tokens = tokens ?? state.note_tokens ?? null
    state.reminded_tokens = null
  }
  if ((state.note_tokens ?? null) === null && tokens !== undefined) {
    // A fresh or just-compacted context starts even with its note; a session
    // first seen mid-way without a note has written none of its work down.
    const rebase = state.rebase === true || modified !== null
    delete state.rebase
    state.note_tokens = rebase ? tokens : 0
  }

  return tokens
}

// ---------------------------------------------------------------------------
// Hook messages

function guidance(concept: string, root: string): string {
  return `${MARKER} This session keeps a handoff note, the OKF concept \`${concept}\` in the bundle \`${root}\`. It is your working memory across context compaction: after a compaction the note is shown to you again, while the rest of the conversation survives only as a summary.

Keep the note current without being asked. Rewrite it with the \`handoff_write\` tool of the \`${SERVER_NAME}\` MCP server, passing note="${concept}", whenever the goal, a decision, the state of the work or the next steps change, and before a long or risky step. Read it with \`handoff_read\`. If those tools are not loaded yet, load them with tool search first. Each write replaces the whole note, so pass the full note every time, in the language of the conversation, with these sections in this order:
${NOTE_SECTIONS}
Record only what the conversation shows, and keep exact names, paths, commands, numbers and error messages. You do not need to tell the person each time you update the note.`
}

function recentNotesText(notes: readonly RecentNote[]): string {
  if (notes.length === 0) {
    return ''
  }
  const lines = notes.map(note => `- \`${note.concept}\`: ${note.title || 'untitled'} (updated ${note.modified})`)

  return `\n\nRecent handoff notes of other sessions in this project:\n${lines.join('\n')}\nWhen the person continues one of these tasks, read that note with \`handoff_read\` and carry what still holds into this session's note.`
}

async function compactedText(store: Store, concept: string): Promise<string> {
  let handoff = (await readNote(store, concept))?.body.trim() ?? ''
  const segments = await segmentsOf(store, concept)
  let text: string
  if (handoff !== '') {
    if (handoff.length > MAX_INJECTED_NOTE_CHARS) {
      handoff = `${handoff.slice(0, MAX_INJECTED_NOTE_CHARS)}\n[clipped: read the rest with handoff_read]`
    }
    text = `\n\nThe context was just compacted. This is the handoff note you kept before it; continue from it together with the summary.\n<handoff-note>\n${handoff}\n</handoff-note>`
  } else {
    text =
      '\n\nThe context was just compacted before the handoff note had any content. Write the note as soon as you have re-established the state.'
  }
  if (segments.length > 0) {
    text += `\n\nThe conversation before the compaction is archived as segments #1-#${segments.length} of this note. When a detail you need is missing, call the \`recall\` tool of the \`${SERVER_NAME}\` MCP server with note="${concept}" and a segment number instead of guessing.`
  }

  return text
}

/** A nudge once `interval` tokens of work have passed since the note last changed, repeated after every further interval. */
function reminder(concept: string, tokens: number, state: State, interval: number): string | undefined {
  const since = tokens - (state.note_tokens ?? 0)
  const reminded = state.reminded_tokens ?? null
  if (since < interval || (reminded !== null && tokens - reminded < interval)) {
    return undefined
  }
  state.reminded_tokens = tokens

  return `${MARKER} About ${since.toLocaleString('en-US')} tokens of work have passed since the handoff note \`${concept}\` was last updated. Update it with \`handoff_write\` at the next good point.`
}

// ---------------------------------------------------------------------------
// Hooks

function hookContext(event: string, text: string): HookOutput {
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } }
}

function sessionNote(payload: Record<string, unknown>, state: State, sessionId: string): string {
  if (typeof state.note === 'string' && NOTE_PATTERN.test(state.note)) {
    return state.note
  }
  const project = process.env.CLAUDE_PROJECT_DIR || (typeof payload.cwd === 'string' && payload.cwd) || process.cwd()

  return noteConcept(handoffFolder(project), sessionId)
}

async function onSessionStart(payload: Record<string, unknown>, state: State, store: Store, concept: string): Promise<HookOutput> {
  let text = guidance(concept, store.root)
  state.guided = true
  const source = payload.source
  const isNew = source === 'startup' || source === 'clear' || source === 'fork'
  if (isNew && (state.note_tokens ?? null) === null) {
    state.rebase = true
  }
  if (source === 'compact') {
    text += await compactedText(store, concept)
  } else if (isNew) {
    text += recentNotesText(await recentNotes(store, concept.slice(0, concept.lastIndexOf('/')), concept))
  } else if (source === 'resume' && (await isFile(notePath(store, concept)))) {
    text += "\n\nThe note already exists from earlier in this session; read it with `handoff_read` when you need it."
  }

  return hookContext('SessionStart', text)
}

/** Runs `body` holding a lock beside `path`, taking over a lock left by a process that died. */
async function withLock<T>(path: string, body: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      await mkdir(lock)
      break
    } catch (error) {
      if (!isRecord(error) || error.code !== 'EEXIST') {
        throw error
      }
      const held = await stat(lock).catch(() => undefined)
      if (held !== undefined && Date.now() - held.mtimeMs > LOCK_STALE_MS) {
        await rm(lock, { recursive: true, force: true })
        continue
      }
      if (Date.now() > deadline) {
        throw new Error(`${lock} is held by another hook`)
      }
      await sleep(50)
    }
  }
  try {
    return await body()
  } finally {
    await rm(lock, { recursive: true, force: true })
  }
}

/**
 * Archives the compacted conversation as a segment and resets the reminder,
 * once per compaction. Claude Code may run SessionStart(compact) before or
 * alongside PostCompact, while Codex runs PostCompact first, so the first of
 * the two archives and the marker file, read under a lock, tells the other.
 */
async function archiveCompaction(
  payload: Record<string, unknown>,
  state: State,
  store: Store,
  concept: string,
  usage: Usage | undefined,
  markerPath: string,
): Promise<void> {
  const transcript = typeof payload.transcript_path === 'string' ? payload.transcript_path : ''
  if (transcript === '' || !(await isFile(transcript))) {
    return
  }
  const marker = (await compactionMarker(transcript)) ?? `unmarked:${await lineCount(transcript)}`
  if (marker === state.archived_marker) {
    return
  }
  await mkdir(dirname(markerPath), { recursive: true })
  await withLock(markerPath, async () => {
    const archived = await readFile(markerPath, 'utf8').catch(() => '')
    if (archived.trim() === marker) {
      return
    }
    const segments = await segmentsOf(store, concept)
    const segment = nextSegment(segments, transcript, await lineCount(transcript), nowIso())
    if (segment !== undefined) {
      await writeNote(store, concept, { segments: [...segments, segment] })
    }
    await writeFile(markerPath, marker, 'utf8')
  })
  // Both hooks of one compaction may reach this with their own state copies;
  // the reset is the same either way.
  state.archived_marker = marker
  state.note_mtime = await noteMtime(store, concept)
  state.note_tokens = null
  state.reminded_tokens = null
  state.stale_usage = usage?.id ?? null
  state.rebase = true
}

async function runHook(dataDir: string, input: string): Promise<HookOutput> {
  const payload: unknown = JSON.parse(input)
  if (!isRecord(payload) || payload.agent_id) {
    return {}
  }
  const sessionId = String(payload.session_id ?? '')
  if (!SESSION_PATTERN.test(sessionId)) {
    return {}
  }
  const event = payload.hook_event_name
  const store = storeAt(bundleRoot(hostName()))
  const state = await loadState(dataDir, sessionId)
  const concept = sessionNote(payload, state, sessionId)
  state.note = concept
  const usage = await transcriptUsage(payload.transcript_path)
  const markerPath = join(dataDir, 'sessions', `${sessionId}.compaction`)
  let output: HookOutput = {}
  if (event === 'SessionStart') {
    if ((await onPath('okf')) === undefined) {
      return { systemMessage: 'okf-wiki-handoff: the okf command is not on PATH, so no handoff note is kept.' }
    }
    if (payload.source === 'compact') {
      await archiveCompaction(payload, state, store, concept, usage, markerPath)
    }
    output = await onSessionStart(payload, state, store, concept)
    await observe(state, store, usage)
  } else if (event === 'PostCompact') {
    await archiveCompaction(payload, state, store, concept, usage, markerPath)
  } else if (event === 'UserPromptSubmit' || event === 'PostToolUse') {
    const tokens = await observe(state, store, usage)
    let message = tokens === undefined ? undefined : reminder(concept, tokens, state, remindTokens())
    if (message !== undefined) {
      if (state.guided !== true) {
        // A session that started before the plugin was enabled never saw the guidance.
        state.guided = true
        message = `${message}\n\n${guidance(concept, store.root)}`
      }
      output = hookContext(event, message)
    }
  }
  await saveState(dataDir, sessionId, state)

  return output
}

async function logError(dataDir: string, error: unknown): Promise<void> {
  try {
    await mkdir(dataDir, { recursive: true })
    const path = join(dataDir, 'errors.log')
    if (((await stat(path).catch(() => undefined))?.size ?? 0) > 256_000) {
      await rm(path, { force: true })
    }
    const name = error instanceof Error ? error.name : 'Error'
    await writeFile(path, `${nowIso()} ${name}: ${errorText(error)}\n`, { encoding: 'utf8', flag: 'a' })
  } catch {
    // Nowhere left to report it.
  }
}

// ---------------------------------------------------------------------------
// MCP server

const NOTE_PROPERTY = {
  type: 'string',
  description: "The handoff note's concept id, as the session's okf-wiki-handoff instructions give it.",
}

const TOOLS = [
  {
    name: 'handoff_read',
    description: "Read this session's okf-wiki-handoff note, or another note of this project.",
    inputSchema: {
      type: 'object',
      properties: { note: NOTE_PROPERTY },
      required: ['note'],
      additionalProperties: false,
    },
  },
  {
    name: 'handoff_write',
    description:
      "Replace the content of this session's okf-wiki-handoff note, creating it when it does not exist. Pass the whole note with the sections # Goal, # State, # Decisions and constraints, # Next steps and # Open questions; the archived segments are kept by the plugin.",
    inputSchema: {
      type: 'object',
      properties: {
        note: NOTE_PROPERTY,
        body: { type: 'string', description: 'The full note in Markdown.' },
        title: { type: 'string', description: 'A short title for the task; optional.' },
      },
      required: ['note', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'recall',
    description:
      'Read the original messages of a conversation segment that a context compaction replaced. Use it when the handoff note lacks a detail you need, such as an exact command, error message or file content.',
    inputSchema: {
      type: 'object',
      properties: {
        note: NOTE_PROPERTY,
        segment: { type: 'integer', minimum: 1, description: 'The archived segment number.' },
        from_line: {
          type: 'integer',
          minimum: 1,
          description: 'The transcript line to continue from, as a previous call reported.',
        },
      },
      required: ['note', 'segment'],
      additionalProperties: false,
    },
  },
]

function checkedNote(input: Record<string, unknown>): string {
  const note = input.note
  if (typeof note !== 'string' || !NOTE_PATTERN.test(note)) {
    throw new Error('Pass "note" as the handoff concept id, such as handoff/<project-key>/<session-id>.')
  }

  return note
}

const TOOL_HANDLERS: Record<string, (store: Store, input: Record<string, unknown>) => Promise<string>> = {
  handoff_read: (store, input) => noteText(store, checkedNote(input)),
  async handoff_write(store, input) {
    const concept = checkedNote(input)
    const body = input.body
    if (typeof body !== 'string' || body.trim() === '') {
      throw new Error('Pass "body" as the full note in Markdown.')
    }
    const title = typeof input.title === 'string' && input.title.trim() !== '' ? input.title.trim() : undefined
    await writeNote(store, concept, { title, body })

    return `Saved ${concept}.`
  },
  async recall(store, input) {
    const concept = checkedNote(input)
    const number = input.segment
    if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) {
      throw new Error('Pass "segment" as a positive integer.')
    }
    const fromLine = typeof input.from_line === 'number' && Number.isInteger(input.from_line) ? input.from_line : undefined

    return recallText(store, concept, number, fromLine)
  },
}

async function mcpResponse(request: Record<string, unknown>, store: Store): Promise<unknown> {
  const id = request.id
  if (id === undefined || id === null) {
    return undefined
  }
  const params = isRecord(request.params) ? request.params : {}
  let result: unknown
  switch (request.method) {
    case 'initialize':
      result = {
        protocolVersion: params.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: VERSION },
      }
      break
    case 'ping':
      result = {}
      break
    case 'tools/list':
      result = { tools: TOOLS }
      break
    case 'tools/call': {
      const handler = typeof params.name === 'string' ? TOOL_HANDLERS[params.name] : undefined
      if (handler === undefined) {
        return { jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown tool' } }
      }
      const input = isRecord(params.arguments) ? params.arguments : {}
      try {
        result = { content: [{ type: 'text', text: await handler(store, input) }] }
      } catch (error) {
        result = { content: [{ type: 'text', text: errorText(error) }], isError: true }
      }
      break
    }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } }
  }

  return { jsonrpc: '2.0', id, result }
}

async function runMcp(host: 'claude' | 'codex'): Promise<void> {
  const store = storeAt(bundleRoot(host))
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY })) {
    if (line.trim() === '') {
      continue
    }
    let request: unknown
    try {
      request = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(request)) {
      continue
    }
    const response = await mcpResponse(request, store)
    if (response !== undefined) {
      process.stdout.write(`${JSON.stringify(response)}\n`)
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
  }

  return Buffer.concat(chunks).toString('utf8')
}

const usage = 'usage: okf_handoff.ts hook --data-dir <dir> | mcp --host claude|codex'

async function main(argv: readonly string[]): Promise<number> {
  const [command, flag, value] = argv
  if (command === 'mcp' && flag === '--host' && (value === 'claude' || value === 'codex')) {
    await runMcp(value)

    return 0
  }
  if (command !== 'hook' || flag !== '--data-dir' || value === undefined || value === '') {
    process.stderr.write(`${usage}\n`)

    return 2
  }
  const dataDir = expandHome(value)
  let output: HookOutput
  try {
    output = await runHook(dataDir, await readStdin())
  } catch (error) {
    // A hook must never break the session.
    await logError(dataDir, error)
    output = {}
  }
  process.stdout.write(`${JSON.stringify(output)}\n`)

  return 0
}

process.exitCode = await main(process.argv.slice(2))
