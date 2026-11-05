// Stop hook of okf-wiki-autosave: journals the latest turn's meaningful work into
// an OKF worklog concept, planned by a child `claude -p` or `codex exec`.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, constants, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'

import { errorText, isRecord, length, pythonJson, tail } from '../lib/core/text.ts'
import {
  AutosaveError,
  acquireLock,
  applyWorklog,
  discoverRoot,
  gitContext,
  loadWorklogContext,
  plannerPrompt,
  updateSchema,
  worklogDirectory,
} from '../lib/core/worklog.ts'
import type { Host, Worklogs } from '../lib/core/worklog.ts'

const MAX_TRANSCRIPT_BYTES = 512_000
const MAX_TURN_SEARCH_BYTES = 16_000_000
const MAX_EVIDENCE_CHARS = 20_000
const MAX_MESSAGE_CHARS = 4_000
const MAX_LAST_MESSAGE_CHARS = 8_000
const MAX_PRIOR_CONTEXT_CHARS = 1_500
const MAX_FALLBACK_MESSAGES = 8
const SYSTEM_ORIGIN_KINDS: ReadonlySet<unknown> = new Set(['task-notification', 'peer', 'coordinator'])
const PLANNER_TIMEOUT_MS = 105_000

type Message = { role: string; content: string }
type Evidence = { prior_context?: string; current_turn: Message[]; workspace?: Record<string, string> }
type Ran = { exitCode: number; stdout: string; stderr: string }

// ---------------------------------------------------------------------------
// Runtime

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
  options: { cwd: string; stdin?: string; env?: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<Ran> {
  return new Promise((done, fail) => {
    const [command, ...args] = argv
    if (command === undefined) {
      fail(new Error('no command to run'))

      return
    }
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, timeout: options.timeoutMs, stdio: 'pipe' })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', fail)
    child.on('close', (code, signal) => {
      if (signal !== null && code === null) {
        fail(new AutosaveError(`${command} timed out`))

        return
      }
      done({ exitCode: code ?? 1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') })
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(options.stdin ?? '')
  })
}

const nodeHost: Host = {
  async okf(root, args, stdin) {
    const executable = await onPath('okf')
    if (executable === undefined) {
      throw new AutosaveError('okf command is not available')
    }
    const ran = await run([executable, '--root', root, '--format', 'json', ...args], { cwd: root, stdin, timeoutMs: 30_000 })
    if (ran.exitCode !== 0) {
      const detail = ran.stderr.trim() || ran.stdout.trim() || `exit ${ran.exitCode}`
      throw new AutosaveError(`okf ${args.join(' ')} failed: ${detail}`)
    }
    if (ran.stdout.trim() === '') {
      return undefined
    }
    try {
      return JSON.parse(ran.stdout)
    } catch {
      throw new AutosaveError('okf returned invalid JSON')
    }
  },
  env: async name => process.env[name],
  home: async () => homedir(),
  realPath: path => realpath(path).catch(() => undefined),
  async kind(path) {
    const found = await stat(path).catch(() => undefined)

    return found === undefined ? undefined : found.isFile() ? 'file' : found.isDirectory() ? 'dir' : 'other'
  },
  mtimeMs: async path => (await stat(path).catch(() => undefined))?.mtimeMs,
  readText: path => readFile(path, 'utf8'),
  list: path => readdir(path).catch(() => []),
  async mkdir(path) {
    await mkdir(path, { recursive: true })
  },
  remove: path => rm(path, { force: true }),
  async createNew(path, text) {
    try {
      const file = await open(path, 'wx', 0o600)
      await file.writeFile(text, 'utf8')
      await file.close()

      return true
    } catch (error) {
      if (isRecord(error) && error.code === 'EEXIST') {
        return false
      }
      throw error
    }
  },
  async gitBranch(cwd) {
    const git = await onPath('git')
    if (git === undefined) {
      return undefined
    }
    const ran = await run([git, 'branch', '--show-current'], { cwd, timeoutMs: 10_000 }).catch((error: unknown) => {
      if (error instanceof AutosaveError) {
        return undefined
      }
      throw error
    })
    const branch = ran?.stdout.trim()

    return ran?.exitCode === 0 && branch ? branch : undefined
  },
  lockOwner: () => String(process.pid),
}

function hookOutput(message?: string): void {
  const payload: Record<string, unknown> = {}
  if (!process.env.PLUGIN_ROOT) {
    payload.suppressOutput = true
  }
  if (message) {
    payload.systemMessage = message
  }
  process.stdout.write(`${pythonJson(payload)}\n`)
}

// ---------------------------------------------------------------------------
// Transcript

function textBlocks(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  if (!Array.isArray(value)) {
    return ''
  }
  const blocks: string[] = []
  for (const item of value) {
    if (typeof item === 'string') {
      blocks.push(item)
    } else if (isRecord(item) && ['text', 'input_text', 'output_text'].includes(String(item.type)) && typeof item.text === 'string') {
      blocks.push(item.text)
    }
  }

  return blocks.join('\n')
}

async function readTranscriptBytes(path: unknown, limit: number = MAX_TRANSCRIPT_BYTES): Promise<Buffer> {
  if (typeof path !== 'string') {
    return Buffer.alloc(0)
  }
  const file = path === '~' || path.startsWith('~/') ? `${homedir()}${path.slice(1)}` : path
  try {
    const handle = await open(file, 'r')
    try {
      const { size } = await handle.stat()
      const start = Math.max(size - limit, 0)
      let raw = Buffer.alloc(size - start)
      await handle.read(raw, 0, raw.length, start)
      if (start > 0) {
        // The first line is cut short.
        const newline = raw.indexOf(0x0a)
        raw = newline === -1 ? Buffer.alloc(0) : raw.subarray(newline + 1)
      }

      return raw
    } finally {
      await handle.close()
    }
  } catch {
    return Buffer.alloc(0)
  }
}

function transcriptItems(raw: Buffer): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = []
  for (const line of raw.toString('utf8').split(/\r\n|\r|\n/)) {
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

/** Parses the transcript tail, widening the window once when a long turn's tool output has pushed its opening prompt out of the default one. */
async function readTranscript(path: unknown): Promise<Record<string, unknown>[]> {
  const items = transcriptItems(await readTranscriptBytes(path))
  if (transcriptMessages(items).some(([opensTurn]) => opensTurn)) {
    return items
  }

  return transcriptItems(await readTranscriptBytes(path, MAX_TURN_SEARCH_BYTES))
}

/**
 * Classifies a Claude Code transcript line as a "human" or "system" prompt, or
 * `undefined` when it is no prompt at all (a reply, tool result, meta line, or
 * sidechain). Relies on the undocumented origin/promptSource transcript fields;
 * a prompt carrying neither counts as human so journaling stays on.
 */
function claudePromptKind(item: Record<string, unknown>): 'human' | 'system' | undefined {
  if (item.type !== 'user' || item.isMeta || item.isSidechain) {
    return undefined
  }
  const message = item.message
  if (!isRecord(message) || message.role !== 'user' || textBlocks(message.content) === '') {
    return undefined
  }
  const originKind = isRecord(item.origin) ? item.origin.kind : undefined
  if (SYSTEM_ORIGIN_KINDS.has(originKind)) {
    return 'system'
  }
  if ((originKind === undefined || originKind === null) && item.promptSource === 'system') {
    return 'system'
  }

  return 'human'
}

/**
 * The transcript's text messages, each flagged when it is a prompt a person
 * sent, which is where a turn begins. Codex response items carry no such
 * marker, so they are never flagged.
 */
function transcriptMessages(items: readonly Record<string, unknown>[]): [boolean, Message][] {
  const claude: [boolean, Message][] = []
  const codexEvents: [boolean, Message][] = []
  const codexItems: [boolean, Message][] = []
  const append = (target: [boolean, Message][], role: unknown, value: unknown, opensTurn: boolean) => {
    if (role !== 'user' && role !== 'assistant') {
      return
    }
    const content = textBlocks(value)
    if (content !== '') {
      target.push([opensTurn, { role, content: tail(content, MAX_MESSAGE_CHARS) }])
    }
  }
  for (const item of items) {
    if (isRecord(item.message)) {
      append(claude, item.message.role, item.message.content, claudePromptKind(item) === 'human')
      continue
    }
    const payload = item.payload
    if (!isRecord(payload)) {
      continue
    }
    if (item.type === 'event_msg') {
      const role = payload.type === 'user_message' ? 'user' : payload.type === 'agent_message' ? 'assistant' : undefined
      append(codexEvents, role, payload.message, role === 'user')
    } else if (item.type === 'response_item' && payload.type === 'message') {
      append(codexItems, payload.role, payload.content, false)
    }
  }

  return claude.length > 0 ? claude : codexEvents.length > 0 ? codexEvents : codexItems
}

/**
 * The planner evidence from the latest turn: its opening prompt and as many of
 * its newest messages as fit, ending with the hook's final answer, plus the
 * closing assistant message of the turn before. Without a recognizable prompt,
 * the last few messages stand in for the turn.
 */
function turnEvidence(items: readonly Record<string, unknown>[], lastMessage: string): Evidence {
  const messages = transcriptMessages(items)
  const starts = messages.flatMap(([opensTurn], index) => (opensTurn ? [index] : []))
  const start = starts.at(-1) ?? Math.max(0, messages.length - MAX_FALLBACK_MESSAGES)
  const turn = messages.slice(start).map(([, message]) => message)
  let prior: string | undefined
  if (starts.length > 0) {
    const before = messages.slice(0, start).reverse().find(([, message]) => message.role === 'assistant')
    prior = before === undefined ? undefined : tail(before[1].content, MAX_PRIOR_CONTEXT_CHARS)
  }
  if (lastMessage !== '') {
    const final = tail(lastMessage, MAX_LAST_MESSAGE_CHARS)
    const last = turn.at(-1)
    // The transcript copy of the final answer is a truncated tail of it, if present.
    if (last !== undefined && last.role === 'assistant' && final.endsWith(last.content)) {
      turn.pop()
    }
    turn.push({ role: 'assistant', content: final })
  }
  let budget = MAX_EVIDENCE_CHARS - length(prior ?? '') - turn.slice(0, 1).reduce((total, message) => total + length(message.content), 0)
  const kept: Message[] = []
  for (const message of turn.slice(1).reverse()) {
    budget -= length(message.content)
    if (budget < 0) {
      break
    }
    kept.push(message)
  }
  const evidence: Evidence = prior ? { prior_context: prior, current_turn: [] } : { current_turn: [] }
  evidence.current_turn = [...turn.slice(0, 1), ...kept.reverse()]

  return evidence
}

/**
 * Whether the newest prompt in a Claude Code transcript came from the system
 * (task notification, monitor event, peer agent) rather than a human. Anything
 * unrecognized (including Codex rollouts) counts as human so journaling stays on.
 */
function isSystemTriggered(items: readonly Record<string, unknown>[]): boolean {
  let kind: string | undefined
  for (const item of items) {
    kind = claudePromptKind(item) ?? kind
  }

  return kind === 'system'
}

// ---------------------------------------------------------------------------
// Planner

function plannerRuntime(): 'claude' | 'codex' {
  const configured = (process.env.OKF_AUTOSAVE_CLI ?? 'auto').trim().toLowerCase()
  if (configured !== 'auto' && configured !== 'claude' && configured !== 'codex') {
    throw new AutosaveError('OKF_AUTOSAVE_CLI must be auto, claude, or codex')
  }
  if (configured !== 'auto') {
    return configured
  }

  return process.env.PLUGIN_ROOT ? 'codex' : 'claude'
}

function plannerChildEnv(runtime: 'claude' | 'codex'): NodeJS.ProcessEnv {
  const env = { ...process.env }
  const providerVariables = {
    claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_VERTEX'],
    codex: ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT'],
  }
  for (const key of providerVariables[runtime]) {
    delete env[key]
  }
  env.OKF_AUTOSAVE_CHILD = '1'
  if (runtime === 'claude') {
    env.CLAUDE_CODE_EFFORT_LEVEL = 'low'
  }

  return env
}

function failure(ran: Ran): string {
  return (ran.stderr.trim() || ran.stdout.trim() || `exit ${ran.exitCode}`).slice(0, 2000)
}

async function requestClaudePlan(root: string, prompt: string, payload: string, schema: unknown): Promise<Record<string, unknown>> {
  const executable = await onPath('claude')
  if (executable === undefined) {
    throw new AutosaveError('claude command is not available')
  }
  const model = process.env.OKF_AUTOSAVE_CLAUDE_MODEL ?? 'sonnet'
  const ran = await run(
    [
      executable,
      '--safe-mode',
      '--settings',
      '{"disableAllHooks":true}',
      '--disable-slash-commands',
      '--strict-mcp-config',
      '--tools',
      '',
      '--no-session-persistence',
      '--model',
      model,
      '--output-format',
      'json',
      '--json-schema',
      pythonJson(schema, { compact: true }),
      '-p',
      prompt,
    ],
    { cwd: root, stdin: payload, env: plannerChildEnv('claude'), timeoutMs: PLANNER_TIMEOUT_MS },
  )
  if (ran.exitCode !== 0) {
    throw new AutosaveError(`claude -p failed: ${failure(ran)}`)
  }
  let response: unknown
  try {
    response = JSON.parse(ran.stdout)
  } catch {
    throw new AutosaveError('claude -p returned invalid JSON')
  }
  const structured = isRecord(response) ? response.structured_output : undefined
  if (!isRecord(structured)) {
    const detail = isRecord(response) ? response.result || response.subtype : undefined
    throw new AutosaveError(`claude -p did not return an update plan: ${detail || 'missing structured output'}`)
  }

  return structured
}

async function requestCodexPlan(prompt: string, payload: string, schema: unknown): Promise<Record<string, unknown>> {
  const executable = await onPath('codex')
  if (executable === undefined) {
    throw new AutosaveError('codex command is not available')
  }
  const isolated = await mkdtemp(join(tmpdir(), 'okf-autosave-codex-'))
  let ran: Ran
  try {
    const schemaPath = join(isolated, 'output-schema.json')
    await writeFile(schemaPath, pythonJson(schema, { compact: true }), 'utf8')
    const command = [
      executable,
      'exec',
      '--ephemeral',
      '--ignore-user-config',
      '--disable',
      'hooks',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '--output-schema',
      schemaPath,
      '--config',
      'model_reasoning_effort="low"',
    ]
    const model = (process.env.OKF_AUTOSAVE_CODEX_MODEL ?? '').trim()
    if (model !== '') {
      command.push('--model', model)
    }
    command.push(prompt)
    ran = await run(command, { cwd: isolated, stdin: payload, env: plannerChildEnv('codex'), timeoutMs: PLANNER_TIMEOUT_MS })
  } finally {
    await rm(isolated, { recursive: true, force: true })
  }
  if (ran.exitCode !== 0) {
    throw new AutosaveError(`codex exec failed: ${failure(ran)}`)
  }
  let structured: unknown
  try {
    structured = JSON.parse(ran.stdout)
  } catch {
    throw new AutosaveError('codex exec returned invalid JSON')
  }
  if (!isRecord(structured)) {
    throw new AutosaveError('codex exec did not return an update plan')
  }

  return structured
}

function requestPlan(root: string, evidence: Evidence, worklogs: Worklogs): Promise<Record<string, unknown>> {
  const schema = updateSchema()
  const prompt = plannerPrompt()
  const payload = pythonJson({ evidence, worklogs }, { compact: true })

  return plannerRuntime() === 'codex' ? requestCodexPlan(prompt, payload, schema) : requestClaudePlan(root, prompt, payload, schema)
}

// ---------------------------------------------------------------------------
// Receipts

function evidenceFingerprint(evidence: Evidence): string {
  return createHash('sha256').update(pythonJson(evidence, { compact: true, sortKeys: true }), 'utf8').digest('hex')
}

async function receiptPath(dataDir: string, root: string): Promise<string> {
  const key = createHash('sha256').update(await realpath(root).catch(() => resolve(root)), 'utf8').digest('hex').slice(0, 20)

  return join(dataDir, `receipt-${key}.json`)
}

async function readReceipt(path: string): Promise<string | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    const fingerprint = isRecord(value) ? value.evidence_fingerprint : undefined

    return typeof fingerprint === 'string' ? fingerprint : undefined
  } catch {
    return undefined
  }
}

async function writeReceipt(path: string, fingerprint: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `.receipt-${process.pid}-${Date.now()}`)
  try {
    const file = await open(temporary, 'w', 0o600)
    try {
      await file.writeFile(`${pythonJson({ evidence_fingerprint: fingerprint }, { compact: true })}\n`, 'utf8')
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
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

async function journal(dataDir: string, input: Record<string, unknown>): Promise<string | undefined> {
  const cwd = resolve(typeof input.cwd === 'string' ? input.cwd : process.cwd())
  const root = await discoverRoot(nodeHost, cwd)
  if (root === undefined) {
    return undefined
  }
  const lock = await acquireLock(nodeHost, dataDir)
  if (lock === undefined) {
    return undefined
  }
  try {
    const worklogDir = await worklogDirectory(nodeHost, root)
    const items = await readTranscript(input.transcript_path)
    if (worklogDir === undefined || isSystemTriggered(items)) {
      return undefined
    }
    const lastMessage = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : ''
    const evidence = turnEvidence(items, lastMessage)
    evidence.workspace = await gitContext(nodeHost, cwd)
    const fingerprint = evidenceFingerprint(evidence)
    const receipt = await receiptPath(dataDir, root)
    if ((await readReceipt(receipt)) === fingerprint) {
      return undefined
    }
    const worklogs = await loadWorklogContext(nodeHost, root, worklogDir, pythonJson(evidence))
    const plan = await requestPlan(root, evidence, worklogs)
    const logged = await applyWorklog(nodeHost, root, worklogDir, plan)
    await writeReceipt(receipt, fingerprint)

    return logged === undefined ? undefined : `OKF autosave: logged ${logged}`
  } finally {
    await rm(lock, { force: true })
  }
}

async function main(argv: readonly string[]): Promise<number> {
  if (process.env.OKF_AUTOSAVE_CHILD === '1') {
    hookOutput()

    return 0
  }
  const [flag, value] = argv
  if (flag !== '--data-dir' || value === undefined || value === '' || argv.length !== 2) {
    process.stderr.write('usage: okf_autosave.ts --data-dir <dir>\n')

    return 2
  }
  let input: unknown
  try {
    input = JSON.parse(await readStdin())
  } catch {
    hookOutput('OKF autosave skipped: invalid Stop hook input')

    return 0
  }
  if (!isRecord(input) || input.hook_event_name !== 'Stop') {
    hookOutput()

    return 0
  }
  const dataDir = resolve(value === '~' || value.startsWith('~/') ? `${homedir()}${value.slice(1)}` : value)
  try {
    hookOutput(await journal(dataDir, input))
  } catch (error) {
    hookOutput(`OKF autosave failed: ${errorText(error)}`)
  }

  return 0
}

process.exitCode = await main(process.argv.slice(2))
