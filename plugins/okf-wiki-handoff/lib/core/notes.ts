import { HANDOFF_TAG, HANDOFF_TYPE, isRecord } from './common.ts'

/** What the note store needs from its runtime: the plugin gives Node's, the mod the engine's. */
export type Host = {
  /** Runs `okf --format json <args>` and resolves its parsed output, or `undefined` for none; rejects when okf fails. */
  okf: (args: readonly string[], stdin?: string) => Promise<unknown>
  exists: (path: string) => Promise<boolean>
  /** The file's modification time in milliseconds, or `undefined` when it cannot be read. */
  mtimeMs: (path: string) => Promise<number | undefined>
  /** Lines `from` to `to` of a text file, both counted from 1, without their newlines. */
  readLines: (path: string, from: number, to: number) => Promise<string[]>
}

/** A handoff bundle and how the notes it creates describe themselves. */
export type Store = { host: Host; root: string; description: string; generatedBy: string }

/** An archived stretch of a transcript, kept in the note's `segments` frontmatter. */
export type Segment = { at: string; transcript: string; from: number; to: number }

export type RecentNote = { concept: string; slug: string; title: string; modified: string }

export const MAX_RECENT_NOTES = 5

export function notePath(store: Store, concept: string): string {
  return `${store.root}/${concept}.md`
}

function okf(store: Store, args: readonly string[], stdin?: string): Promise<unknown> {
  return store.host.okf(['--root', store.root, ...args], stdin)
}

export async function ensureBundle(store: Store): Promise<void> {
  if (!(await store.host.exists(`${store.root}/index.md`))) {
    await okf(store, ['init'])
  }
}

function isSegment(value: unknown): value is Segment {
  if (!isRecord(value)) {
    return false
  }
  const { at, transcript, from, to } = value

  return typeof at === 'string' && typeof transcript === 'string' && Number.isInteger(from) && Number.isInteger(to)
}

export async function segmentsOf(store: Store, concept: string): Promise<Segment[]> {
  if (!(await store.host.exists(notePath(store, concept)))) {
    return []
  }
  // `meta get` fails on a key that is not there yet, which is a note with no segments.
  const stored = await okf(store, ['meta', 'get', concept, 'segments']).catch(() => undefined)

  return Array.isArray(stored) ? stored.filter(isSegment) : []
}

/** The segment that archives `transcript` past what `segments` already holds, if it has grown. */
export function nextSegment(
  segments: readonly Segment[],
  transcript: string,
  lastLine: number,
  at: string,
): Segment | undefined {
  const archived = segments
    .filter(segment => segment.transcript === transcript)
    .reduce((highest, segment) => Math.max(highest, segment.to), 0)

  return lastLine > archived ? { at, transcript, from: archived + 1, to: lastLine } : undefined
}

export async function readNote(
  store: Store,
  concept: string,
): Promise<{ body: string; identity: string } | undefined> {
  if (!(await store.host.exists(notePath(store, concept)))) {
    return undefined
  }
  const current = await okf(store, ['body', 'get', concept])
  if (!isRecord(current) || typeof current.identity !== 'string') {
    throw new Error(`okf body get ${concept} returned no identity`)
  }

  return { body: typeof current.body === 'string' ? current.body : '', identity: current.identity }
}

export async function noteTitle(store: Store, concept: string): Promise<string> {
  const title = await okf(store, ['meta', 'get', concept, 'title']).catch(() => undefined)

  return typeof title === 'string' ? title : ''
}

/**
 * Writes the note, creating it first when it is missing. Each field left out
 * keeps what the note holds: `body` its text, `segments` its archive.
 */
export async function writeNote(
  store: Store,
  concept: string,
  options: { title?: string; body?: string; segments?: readonly Segment[] },
): Promise<void> {
  if (!(await store.host.exists(notePath(store, concept)))) {
    await ensureBundle(store)
    await okf(store, [
      'new',
      concept,
      '--type',
      HANDOFF_TYPE,
      '--title',
      options.title ?? `Handoff ${new Date().toISOString().slice(0, 10)}`,
      '--description',
      store.description,
      '--tag',
      HANDOFF_TAG,
      '--generated-by',
      store.generatedBy,
    ])
  } else if (options.title !== undefined) {
    await okf(store, ['meta', 'set', concept, 'title', options.title])
  }
  if (options.segments !== undefined) {
    await okf(store, ['meta', 'set', concept, 'segments', JSON.stringify(options.segments), '--type', 'json'])
  }
  if (options.body === undefined) {
    return
  }
  const current = await readNote(store, concept)
  if (current === undefined) {
    throw new Error(`${concept} disappeared while it was written`)
  }
  const text = options.body.trim()
  await okf(store, ['body', 'set', concept, '--if-match', current.identity], text === '' ? '' : `${text}\n`)
}

/** The project's most recently changed notes other than `exclude`, newest first. */
export async function recentNotes(store: Store, folder: string, exclude: string): Promise<RecentNote[]> {
  if (!(await store.host.exists(`${store.root}/${folder}`))) {
    return []
  }
  const records = await okf(store, ['list', folder, '--tag', HANDOFF_TAG])
  if (!Array.isArray(records)) {
    return []
  }
  const notes: (RecentNote & { mtimeMs: number })[] = []
  for (const record of records) {
    const concept = isRecord(record) && typeof record.id === 'string' ? record.id : undefined
    if (concept === undefined || !concept.startsWith(`${folder}/`) || concept === exclude) {
      continue
    }
    const mtimeMs = await store.host.mtimeMs(notePath(store, concept))
    if (mtimeMs === undefined) {
      continue
    }
    notes.push({
      concept,
      slug: concept.slice(folder.length + 1),
      title: isRecord(record) ? String(record.title ?? '') : '',
      modified: `${new Date(mtimeMs).toISOString().slice(0, 16).replace('T', ' ')} UTC`,
      mtimeMs,
    })
  }

  return notes
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, MAX_RECENT_NOTES)
    .map(({ concept, slug, title, modified }) => ({ concept, slug, title, modified }))
}

/** What `handoff_read` answers for a note. */
export async function noteText(store: Store, concept: string): Promise<string> {
  const note = await readNote(store, concept)
  if (note === undefined) {
    return `${concept} has not been written yet.`
  }
  const segments = await segmentsOf(store, concept)
  const footer = segments.length === 0 ? '' : `\n\n[${segments.length} archived segments: read them with recall]`
  const title = await noteTitle(store, concept)
  const heading = title === '' ? concept : `${concept} (${title})`

  return `${heading}\n\n${note.body.trim() || '(empty)'}${footer}`
}
