import type { EngineInterface, Register, SessionCompactInput, SessionCompactResult } from 'claude-code'

import {
  HANDOFF_DIR,
  HANDOFF_TAG,
  HANDOFF_TYPE,
  RECALL_TOOL,
  handoffMessage,
  keptTail,
  latestPrompt,
  noteBody,
  parsePlan,
  plannerPrompt,
  projectKey,
  recentToolResults,
  renderEntries,
} from './handoff'
import type { HandoffEntry, Segment } from './handoff'

const OKF_TIMEOUT_MS = 30_000
const RECALL_CHUNK_LINES = 200
const RECALL_MAX_CHARS = 30_000
const GENERATED_BY = 'process:okf-wiki-handoff-mod'
const DESCRIPTION = 'Handoff note that replaced a compacted Claude Code conversation.'
const BUNDLE_NAME = 'okf-handoff'

/** The handoff bundle and this project's folder of handoff concepts in it. */
type Place = { root: string; folder: string }

type SessionRecord = { slug?: string }

const RECALL_SCHEMA = {
  type: 'object',
  properties: {
    segment: { type: 'integer', minimum: 1, description: 'The archived segment number.' },
    handoff: {
      type: 'string',
      description: "The handoff slug in this project; defaults to this session's handoff.",
    },
    from_line: {
      type: 'integer',
      minimum: 1,
      description: 'The transcript line to continue from, as a previous call reported.',
    },
  },
  required: ['segment'],
}

const RECALL_DESCRIPTION =
  'Read the original messages of a conversation segment that an okf-wiki handoff replaced. Use it when the handoff note lacks a detail you need, such as an exact command, error message or file content.'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function okf($: EngineInterface, args: readonly string[], stdin?: string): Promise<unknown> {
  const ran = await $.process.run(['okf', '--format', 'json', ...args], {
    stdin,
    timeoutMs: OKF_TIMEOUT_MS,
  })
  if (ran.exitCode !== 0) {
    throw new Error(`okf ${args.join(' ')} failed: ${ran.stderr.trim() || `exit ${ran.exitCode}`}`)
  }

  return ran.stdout.trim() === '' ? undefined : JSON.parse(ran.stdout)
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
  const root = `${await claudeDirectory($)}/${BUNDLE_NAME}`
  if (!(await $.fs.exists(`${root}/index.md`))) {
    if (!isCreating) {
      return undefined
    }
    await okf($, ['--root', root, 'init'])
  }

  return { root, folder: `${HANDOFF_DIR}/${projectKey(await $.session.root())}` }
}

async function knownHandoffs($: EngineInterface, place: Place): Promise<HandoffEntry[]> {
  if (!(await $.fs.exists(`${place.root}/${place.folder}`))) {
    return []
  }
  const records = await okf($, ['--root', place.root, 'list', place.folder, '--tag', HANDOFF_TAG])
  if (!Array.isArray(records)) {
    return []
  }
  const prefix = `${place.folder}/`

  return records.flatMap(record =>
    typeof record?.id === 'string' && record.id.startsWith(prefix)
      ? [{ slug: record.id.slice(prefix.length), title: String(record.title ?? '') }]
      : [],
  )
}

function isSegment(value: unknown): value is Segment {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const { at, transcript, from, to } = value as Record<string, unknown>

  return (
    typeof at === 'string' &&
    typeof transcript === 'string' &&
    typeof from === 'number' &&
    typeof to === 'number'
  )
}

async function segmentsOf($: EngineInterface, place: Place, concept: string): Promise<Segment[]> {
  if (!(await $.fs.exists(`${place.root}/${concept}.md`))) {
    return []
  }
  // `meta get` fails on a key that is not there yet, which is a note with no segments.
  const stored = await okf($, ['--root', place.root, 'meta', 'get', concept, 'segments']).catch(
    () => undefined,
  )

  return Array.isArray(stored) ? stored.filter(isSegment) : []
}

async function writeNote(
  $: EngineInterface,
  place: Place,
  concept: string,
  title: string,
  body: string,
  segments: readonly Segment[],
): Promise<void> {
  const root = ['--root', place.root]
  if (!(await $.fs.exists(`${place.root}/${concept}.md`))) {
    await okf($, [
      ...root,
      'new',
      concept,
      '--type',
      HANDOFF_TYPE,
      '--title',
      title,
      '--description',
      DESCRIPTION,
      '--tag',
      HANDOFF_TAG,
      '--generated-by',
      GENERATED_BY,
    ])
  }
  if (segments.length > 0) {
    await okf($, [...root, 'meta', 'set', concept, 'segments', JSON.stringify(segments), '--type', 'json'])
  }
  const current = await okf($, [...root, 'body', 'get', concept])
  const identity =
    typeof current === 'object' && current !== null && 'identity' in current
      ? String(current.identity)
      : undefined
  if (identity === undefined) {
    throw new Error(`okf body get ${concept} returned no identity`)
  }
  await okf($, [...root, 'body', 'set', concept, '--if-match', identity], body)
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

async function sessionKey($: EngineInterface): Promise<string> {
  return `session:${await $.session.id()}`
}

async function sessionRecord($: EngineInterface): Promise<SessionRecord> {
  const stored = await $.store.get(await sessionKey($))

  return typeof stored === 'object' && stored !== null ? (stored as SessionRecord) : {}
}

async function replaceWithHandoff(
  $: EngineInterface,
  e: SessionCompactInput,
  transcript: string | undefined,
): Promise<SessionCompactResult> {
  const place = await handoffPlace($, true)
  if (place === undefined) {
    throw new Error('the handoff bundle could not be created')
  }
  const record = await sessionRecord($)
  const reply = await $.model.fork({
    prompt: plannerPrompt({
      currentSlug: record.slug,
      known: await knownHandoffs($, place),
      instructions: e.instructions,
      recentResults: recentToolResults(e.messages),
    }),
  })
  if (!reply.isAnswered) {
    throw new Error(`the handoff request ended with ${reply.reason}`)
  }
  const plan = parsePlan(reply.text)
  if (plan === undefined) {
    throw new Error('the handoff reply was not a handoff plan')
  }
  const slug = record.slug ?? plan.slug
  const concept = `${place.folder}/${slug}`

  const segments = await segmentsOf($, place, concept)
  const lastLine = transcript === undefined ? undefined : await lineCount($, transcript)
  if (transcript !== undefined && lastLine !== undefined) {
    const archived = segments
      .filter(segment => segment.transcript === transcript)
      .reduce((highest, segment) => Math.max(highest, segment.to), 0)
    if (lastLine > archived) {
      segments.push({ at: new Date().toISOString(), transcript, from: archived + 1, to: lastLine })
    }
  }

  await writeNote($, place, concept, plan.title, noteBody(plan.handoff, segments), segments)
  await $.store.set(await sessionKey($), { slug })

  const tail = keptTail(e.messages)
  const text = handoffMessage({
    root: place.root,
    concept,
    handoff: plan.handoff,
    prompt: tail.length === 0 ? latestPrompt(e.messages) : undefined,
    segments: segments.length,
  })
  $.ui.toast(`okf handoff: replaced the conversation with ${concept}`)

  return { messages: [{ role: 'user', text, toolUses: [] }, ...tail] }
}

async function recall($: EngineInterface, input: Record<string, unknown>): Promise<string> {
  const number = input.segment
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) {
    return 'Pass "segment" as a positive integer.'
  }
  const place = await handoffPlace($, false)
  if (place === undefined) {
    return 'No handoff has been written on this machine yet.'
  }
  const slug =
    typeof input.handoff === 'string' && input.handoff !== ''
      ? input.handoff
      : (await sessionRecord($)).slug
  if (slug === undefined) {
    return 'This session has no handoff yet; pass "handoff" with the handoff slug.'
  }
  const concept = `${place.folder}/${slug}`
  const segments = await segmentsOf($, place, concept)
  const segment = segments[number - 1]
  if (segment === undefined) {
    return `${concept} has ${segments.length} archived segments.`
  }
  const requested = typeof input.from_line === 'number' ? input.from_line : segment.from
  const from = Math.min(Math.max(requested, segment.from), segment.to)
  const to = Math.min(from + RECALL_CHUNK_LINES - 1, segment.to)
  const ran = await $.process.run(['sed', '-n', `${from},${to}p;${to}q`, segment.transcript], {
    timeoutMs: OKF_TIMEOUT_MS,
  })
  if (ran.exitCode !== 0) {
    return `Cannot read the archived transcript: ${ran.stderr.trim() || `exit ${ran.exitCode}`}`
  }
  const lines = ran.stdout.split('\n')
  // A truncated read ends mid-line, and the final newline leaves an empty piece.
  lines.pop()
  const rendered = renderEntries(lines, from, RECALL_MAX_CHARS)
  const readUpTo = from + lines.length
  const next = rendered.nextLine ?? (readUpTo <= segment.to ? readUpTo : undefined)
  const footer =
    next === undefined
      ? `[end of segment #${number}]`
      : `[segment #${number} continues: call recall again with from_line=${next}]`

  return `Segment #${number} of ${concept}, archived ${segment.at}.\n\n${rendered.text}\n\n${footer}`
}

export const register: Register = on => {
  let transcript: string | undefined

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'recall',
      description: RECALL_DESCRIPTION,
      inputSchema: RECALL_SCHEMA,
      isDeferred: false,
    })

    return next(e)
  })

  // Classic events carry the transcript path, which the archive points into.
  on('classic.SessionStart', ($, e, next) => {
    transcript = e.transcript_path || transcript

    return next(e)
  })
  on('classic.UserPromptSubmit', ($, e, next) => {
    transcript = e.transcript_path || transcript

    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined) {
      return next(e)
    }
    // The handoff is written when the compaction runs, so a precomputed summary would be wasted.
    if (e.trigger === 'precompute') {
      return { skip: 'okf-wiki-handoff-mod writes a handoff when the compaction runs' }
    }
    $.ui.status('okf handoff: writing')
    try {
      return await replaceWithHandoff($, e, await transcriptPath($, transcript))
    } catch (error) {
      $.ui.toast(`okf handoff failed, compacting as usual: ${errorText(error)}`)

      return next(e)
    } finally {
      $.ui.status(undefined)
    }
  })

  on('tool.call', { tool: RECALL_TOOL }, async ($, e) => ({
    result: await recall($, e as unknown as Record<string, unknown>).catch(
      (error: unknown) => `recall failed: ${errorText(error)}`,
    ),
  }))
}
