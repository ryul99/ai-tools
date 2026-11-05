// UserPromptSubmit hook of english-lecturer: asks a child `claude -p` or `codex exec`
// for a lesson on the prompt and shows it as a system message.
// acknowledge: https://github.com/crescent-stdio for prompt

import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LESSON_SCHEMA, lessonPrompt, toLesson } from '../lib/core/lesson.ts'
import type { Lesson } from '../lib/core/lesson.ts'

const LESSON_TIMEOUT_MS = 110_000

type Ran = { exitCode: number; stdout: string; stderr: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function run(argv: readonly string[], options: { stdin: string; env: NodeJS.ProcessEnv }): Promise<Ran> {
  return new Promise((done, fail) => {
    const [command, ...args] = argv
    if (command === undefined) {
      fail(new Error('no command to run'))

      return
    }
    const child = spawn(command, args, { env: options.env, timeout: LESSON_TIMEOUT_MS, stdio: 'pipe' })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', fail)
    child.on('close', code => {
      done({ exitCode: code ?? 1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') })
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(options.stdin)
  })
}

function hookOutput(message: string): void {
  const payload = process.env.PLUGIN_ROOT ? { systemMessage: message } : { suppressOutput: false, systemMessage: message }
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

/** The child's failure as the shell captured it: its stderr without the trailing newlines. */
function detail(ran: Ran | Error): string {
  const text = ran instanceof Error ? ran.message : ran.stderr

  return text.replace(/\n+$/, '') || 'unknown error'
}

async function codexLesson(prompt: string): Promise<{ lesson?: unknown; failure?: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'english-lecturer-'))
  try {
    const schema = join(directory, 'response.json')
    await writeFile(schema, JSON.stringify(LESSON_SCHEMA), 'utf8')
    const command = [
      'codex',
      'exec',
      '--ephemeral',
      '--ignore-user-config',
      '--disable',
      'hooks',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '--output-schema',
      schema,
      '--config',
      'model_reasoning_effort="low"',
    ]
    if (process.env.ENGLISH_LECTURER_CODEX_MODEL) {
      command.push('--model', process.env.ENGLISH_LECTURER_CODEX_MODEL)
    }
    command.push('-')
    const ran = await run(command, { stdin: prompt, env: { ...process.env, ENGLISH_LECTURER_CHILD: '1' } }).catch((error: Error) => error)
    if (ran instanceof Error || ran.exitCode !== 0) {
      return { failure: `Failed to generate lesson with Codex: ${detail(ran)}` }
    }
    try {
      return { lesson: JSON.parse(ran.stdout) }
    } catch {
      return { failure: 'Failed to generate lesson: unknown error' }
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function claudeLesson(prompt: string): Promise<{ lesson?: unknown; failure?: string }> {
  const ran = await run(
    [
      'claude',
      '--tools=',
      '--strict-mcp-config',
      '--no-session-persistence',
      '--safe-mode',
      '--disable-slash-commands',
      '--model',
      process.env.ENGLISH_LECTURER_CLAUDE_MODEL || 'haiku',
      '--settings',
      '{ "disableAllHooks": true }',
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(LESSON_SCHEMA),
      '-p',
      prompt,
    ],
    {
      stdin: '',
      env: {
        ...process.env,
        CLAUDE_CODE_EFFORT_LEVEL: 'low',
        MAX_THINKING_TOKENS: '2000',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
        CLAUDE_CODE_SIMPLE: '0',
        ENGLISH_LECTURER_CHILD: '1',
      },
    },
  ).catch((error: Error) => error)
  if (ran instanceof Error || ran.exitCode !== 0) {
    return { failure: `Failed to generate lesson with Claude: ${detail(ran)}` }
  }
  let response: unknown
  try {
    response = JSON.parse(ran.stdout)
  } catch {
    return { failure: 'Failed to generate lesson: unknown error' }
  }
  const structured = isRecord(response) ? response.structured_output : undefined
  if (structured === undefined || structured === null) {
    const result = isRecord(response) && response.result ? String(response.result) : 'unknown error'

    return { failure: `Failed to generate lesson: ${result}` }
  }

  return { lesson: structured }
}

/** The lesson as the shell version printed it: the rewrite, each correction, then the tip. */
function lessonText(lesson: Lesson): string {
  const trim = (text: string) => text.replace(/\n+$/, '')
  const corrections = lesson.hasCorrections
    ? trim(lesson.corrections.map(item => `- ✅ ${item.category}: ${item.original} → ${item.suggestion}\n  - ${item.explanation}\n`).join('\n'))
    : ''

  return `\n\n${trim(lesson.enhancedPrompt)}\n${corrections === '' ? '' : `\n${corrections}\n`}\n✨ ${trim(lesson.tip)}`
}

async function main(): Promise<void> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
  }
  if (process.env.ENGLISH_LECTURER_CHILD === '1') {
    return
  }
  let input: unknown
  try {
    input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return
  }
  // A subagent's prompt, or a notification about one, is not the person's English.
  if (!isRecord(input) || input.agent_id || input.agent_type) {
    return
  }
  const prompt = typeof input.prompt === 'string' ? input.prompt : ''
  if (prompt.trim() === '' || prompt.startsWith('<task-notification>')) {
    return
  }
  const request = lessonPrompt(prompt.replace(/\n+$/, ''), 'schema')
  const reply = process.env.PLUGIN_ROOT ? await codexLesson(request) : await claudeLesson(request)
  if (reply.failure !== undefined) {
    hookOutput(reply.failure)

    return
  }
  const lesson = toLesson(reply.lesson)
  hookOutput(lesson === undefined ? 'Failed to generate lesson: the reply was not a lesson' : lessonText(lesson))
}

await main()
