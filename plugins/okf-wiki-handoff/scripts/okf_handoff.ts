// Hooks and MCP server of okf-wiki-handoff.
//
// The hooks keep the agent writing a per-session OKF handoff note and bring that
// note back after a context compaction. The MCP server gives the agent the tools
// to read, write, append to and search the notes, and to list, search and read
// the project's transcripts.

import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { access, constants, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

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
import { HISTORY_TOOLS, isHistoryTool, runHistoryTool } from '../lib/core/history.ts'
import type { Locator } from '../lib/core/history.ts'
import {
  MAX_SEARCH_RESULTS,
  NOTE_CONTENT,
  notePath,
  noteText,
  noteTitle,
  readNote,
  recentNotes,
  searchNotesText,
  writeNote,
} from '../lib/core/notes.ts'
import type { DirEntry, Host, RecentNote, Store } from '../lib/core/notes.ts'

const VERSION = '0.3.0'
const SERVER_NAME = 'okf-handoff'
const GENERATED_BY = 'process:okf-wiki-handoff'
const DESCRIPTION = 'Handoff note an agent keeps current so its session survives context compaction.'
const NOTE_PATTERN = /^handoff\/[A-Za-z0-9-]+\/[a-z0-9][a-z0-9-]{0,63}$/
const SESSION_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

const OKF_TIMEOUT_MS = 30_000
const USAGE_TAIL_BYTES = 1_000_000
const USAGE_WIDE_TAIL_BYTES = 16_000_000
const MAX_INJECTED_NOTE_CHARS = 20_000

type Usage = { id: string; tokens: number }

/** What the hooks remember about a session between events, in the plugin data directory. */
type State = {
  note?: string
  guided?: boolean
  rebase?: boolean
  note_mtime?: number | null
  note_tokens?: number | null
  reminded_tokens?: number | null
  compaction_marker?: string
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

function configDirectory(host: 'claude' | 'codex'): string {
  const variable = host === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'
  const configured = (process.env[variable] ?? '').trim()

  return configured === '' ? join(homedir(), host === 'codex' ? '.codex' : '.claude') : expandHome(configured)
}

function bundleRoot(host: 'claude' | 'codex'): string {
  return join(configDirectory(host), BUNDLE_NAME)
}

/** Where the CLI keeps its transcripts: Claude Code's `projects` folder or Codex's `sessions` folder. */
function transcriptRoot(host: 'claude' | 'codex'): string {
  return join(configDirectory(host), host === 'codex' ? 'sessions' : 'projects')
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
  async list(path) {
    const entries = await readdir(path, { withFileTypes: true }).catch(() => [])
    const listed: DirEntry[] = []
    for (const entry of entries) {
      const kind = entry.isFile() ? 'file' : entry.isDirectory() ? 'dir' : 'other'
      const mtimeMs = kind === 'file' ? ((await stat(join(path, entry.name)).catch(() => undefined))?.mtimeMs ?? 0) : 0
      listed.push({ name: entry.name, kind, mtimeMs })
    }

    return listed
  },
  readText: path => readFile(path, 'utf8').catch(() => undefined),
  lineCount,
  async grep(path, needle, limit) {
    const lowered = needle.toLowerCase()
    const hits: { number: number; text: string }[] = []
    let number = 0
    for await (const line of fileLines(path)) {
      number += 1
      if (line.toLowerCase().includes(lowered)) {
        hits.push({ number, text: line })
        if (hits.length >= limit) {
          break
        }
      }
    }

    return hits
  },
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
  return `${MARKER} This session keeps a handoff note, the OKF concept \`${concept}\` in the bundle \`${root}\`. It is your working memory across context compaction: after a compaction the note is shown to you again, while the rest of the conversation survives only as a summary and in the session's transcript.

Keep the note current without being asked, with the tools of the \`${SERVER_NAME}\` MCP server, each called with note="${concept}". If those tools are not loaded yet, load them with tool search first.
- \`handoff_append\` adds to the end of the note. Use it as things happen: a decision, a finding, a finished step, a new rule from the person.
- \`handoff_write\` replaces the whole note. Use it to reorganize the note or drop what no longer holds, and before a long or risky step.
- \`handoff_read\` reads the note or another note of this project, and \`handoff_search\` finds the project's notes that mention a text.
- \`history_list\`, \`history_search\` and \`history_read\` list, search and read the original messages of this project's sessions and their subagents, compacted or not. When the note or a summary lacks a detail you need, such as an exact command, error message or file content, look it up there instead of guessing.

Write the note in the language of the conversation. ${NOTE_CONTENT} You do not need to tell the person each time you update the note.`
}

function recentNotesText(notes: readonly RecentNote[]): string {
  if (notes.length === 0) {
    return ''
  }
  const lines = notes.map(note => `- \`${note.concept}\`: ${note.title || 'untitled'} (updated ${note.modified})`)

  return `\n\nRecent handoff notes of other sessions in this project:\n${lines.join('\n')}\nWhen the person continues one of these tasks, or an older one you find with \`handoff_search\`, read that note with \`handoff_read\` and carry what still holds into this session's note.`
}

async function compactedText(store: Store, concept: string): Promise<string> {
  let handoff = (await readNote(store, concept))?.body.trim() ?? ''
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

  return `${text}\n\nThe conversation before the compaction is still in this session's transcript. When a detail you need is missing, find it with \`history_search\` or read it with \`history_read\` instead of guessing.`
}

/** A nudge once `interval` tokens of work have passed since the note last changed, repeated after every further interval. */
function reminder(concept: string, tokens: number, state: State, interval: number): string | undefined {
  const since = tokens - (state.note_tokens ?? 0)
  const reminded = state.reminded_tokens ?? null
  if (since < interval || (reminded !== null && tokens - reminded < interval)) {
    return undefined
  }
  state.reminded_tokens = tokens

  return `${MARKER} About ${since.toLocaleString('en-US')} tokens of work have passed since the handoff note \`${concept}\` was last updated. Update it with \`handoff_append\` or \`handoff_write\` at the next good point.`
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

/**
 * Resets the reminder once per compaction. Claude Code may run
 * SessionStart(compact) before or alongside PostCompact, while Codex runs
 * PostCompact first; the transcript's compaction marker tells a later hook
 * that the compaction was already seen.
 */
async function resetAfterCompaction(
  payload: Record<string, unknown>,
  state: State,
  store: Store,
  concept: string,
  usage: Usage | undefined,
): Promise<void> {
  const transcript = typeof payload.transcript_path === 'string' ? payload.transcript_path : ''
  if (transcript === '' || !(await isFile(transcript))) {
    return
  }
  const marker = (await compactionMarker(transcript)) ?? `unmarked:${await lineCount(transcript)}`
  if (marker === state.compaction_marker) {
    return
  }
  // Both hooks of one compaction may reach this with their own state copies;
  // the reset is the same either way.
  state.compaction_marker = marker
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
  let output: HookOutput = {}
  if (event === 'SessionStart') {
    if ((await onPath('okf')) === undefined) {
      return { systemMessage: 'okf-wiki-handoff: the okf command is not on PATH, so no handoff note is kept.' }
    }
    if (payload.source === 'compact') {
      await resetAfterCompaction(payload, state, store, concept, usage)
    }
    output = await onSessionStart(payload, state, store, concept)
    await observe(state, store, usage)
  } else if (event === 'PostCompact') {
    await resetAfterCompaction(payload, state, store, concept, usage)
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
  description: "This session's handoff note concept id, as the session's okf-wiki-handoff instructions give it.",
}

function withNote(properties: Record<string, unknown>, required: readonly string[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: { note: NOTE_PROPERTY, ...properties },
    required: ['note', ...required],
    additionalProperties: false,
  }
}

const TITLE_PROPERTY = { type: 'string', description: 'A short title for the task; optional.' }

const TOOLS = [
  {
    name: 'handoff_read',
    description:
      "Read this session's okf-wiki-handoff note, or another note of this project: pass that note's concept id as note.",
    inputSchema: withNote({}, []),
  },
  {
    name: 'handoff_write',
    description:
      "Replace the whole content of this session's okf-wiki-handoff note, creating it when it does not exist. The note has no fixed layout.",
    inputSchema: withNote({ body: { type: 'string', description: 'The whole note in Markdown.' }, title: TITLE_PROPERTY }, ['body']),
  },
  {
    name: 'handoff_append',
    description:
      "Add text to the end of this session's okf-wiki-handoff note, creating it when it does not exist, without passing the rest of the note again.",
    inputSchema: withNote({ text: { type: 'string', description: 'The Markdown to add.' }, title: TITLE_PROPERTY }, ['text']),
  },
  {
    name: 'handoff_search',
    description:
      "Find the okf-wiki-handoff notes of this project that mention a text, in their titles or bodies, with the matching lines. Read a note it finds with handoff_read.",
    inputSchema: withNote(
      {
        query: { type: 'string', description: 'The text to find.' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_RESULTS, description: 'How many matching lines to return; 20 by default.' },
      },
      ['query'],
    ),
  },
  ...Object.entries(HISTORY_TOOLS).map(([name, tool]) => ({
    name,
    description: tool.description,
    inputSchema: withNote(tool.properties, tool.required),
  })),
]

/** The note a tool names, and the project folder and session it belongs to. */
function checkedNote(input: Record<string, unknown>): { concept: string; folder: string; key: string; slug: string } {
  const note = input.note
  if (typeof note !== 'string' || !NOTE_PATTERN.test(note)) {
    throw new Error('Pass "note" as the handoff concept id, such as handoff/<project-key>/<session-id>.')
  }
  const [, key = '', slug = ''] = note.split('/')

  return { concept: note, folder: note.slice(0, note.lastIndexOf('/')), key, slug }
}

function requiredText(input: Record<string, unknown>, key: string, what: string): string {
  const value = input[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Pass "${key}" as ${what}.`)
  }

  return value
}

function optionalTitle(input: Record<string, unknown>): string | undefined {
  return typeof input.title === 'string' && input.title.trim() !== '' ? input.title.trim() : undefined
}

type Server = { store: Store; host: 'claude' | 'codex' }

const TOOL_HANDLERS: Record<string, (server: Server, input: Record<string, unknown>) => Promise<string>> = {
  handoff_read: ({ store }, input) => noteText(store, checkedNote(input).concept),
  async handoff_write({ store }, input) {
    const { concept } = checkedNote(input)
    await writeNote(store, concept, { title: optionalTitle(input), body: requiredText(input, 'body', 'the whole note in Markdown') })

    return `Saved ${concept}.`
  },
  async handoff_append({ store }, input) {
    const { concept } = checkedNote(input)
    await writeNote(store, concept, {
      title: optionalTitle(input),
      body: requiredText(input, 'text', 'the Markdown to add'),
      append: true,
    })

    return `Appended to ${concept}.`
  },
  handoff_search({ store }, input) {
    const { folder } = checkedNote(input)
    const limit = typeof input.limit === 'number' && Number.isInteger(input.limit) && input.limit > 0 ? input.limit : 20

    return searchNotesText(store, folder, requiredText(input, 'query', 'the text to find'), Math.min(limit, MAX_SEARCH_RESULTS))
  },
}

async function callTool(server: Server, name: string, input: Record<string, unknown>): Promise<string | undefined> {
  const handler = TOOL_HANDLERS[name]
  if (handler !== undefined) {
    return await handler(server, input)
  }
  if (!isHistoryTool(name)) {
    return undefined
  }
  const { folder, key, slug } = checkedNote(input)
  const locator: Locator = { kind: server.host, root: transcriptRoot(server.host), key, sessionId: slug }

  return await runHistoryTool(name, nodeHost, locator, input, sessionId => noteTitle(server.store, noteConcept(folder, sessionId)))
}

async function mcpResponse(request: Record<string, unknown>, server: Server): Promise<unknown> {
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
      const name = typeof params.name === 'string' ? params.name : ''
      const input = isRecord(params.arguments) ? params.arguments : {}
      try {
        const text = await callTool(server, name, input)
        if (text === undefined) {
          return { jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown tool' } }
        }
        result = { content: [{ type: 'text', text }] }
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
  const server: Server = { store: storeAt(bundleRoot(host)), host }
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
    const response = await mcpResponse(request, server)
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
