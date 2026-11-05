import { HANDOFF_TAG, HANDOFF_TYPE, isRecord } from './common.ts'

export type DirEntry = { name: string; kind: 'file' | 'dir' | 'other'; mtimeMs: number }

/** What the note store and the history need from their runtime: the plugin gives Node's, the mod the engine's. */
export type Host = {
  /** Runs `okf --format json <args>` and resolves its parsed output, or `undefined` for none; rejects when okf fails. */
  okf: (args: readonly string[], stdin?: string) => Promise<unknown>
  exists: (path: string) => Promise<boolean>
  /** The file's modification time in milliseconds, or `undefined` when it cannot be read. */
  mtimeMs: (path: string) => Promise<number | undefined>
  /** The entries of a directory, or none when it cannot be listed. */
  list: (path: string) => Promise<DirEntry[]>
  /** A small file's text, or `undefined` when it cannot be read. */
  readText: (path: string) => Promise<string | undefined>
  /** Lines `from` to `to` of a text file, both counted from 1, without their newlines. */
  readLines: (path: string, from: number, to: number) => Promise<string[]>
  lineCount: (path: string) => Promise<number>
  /**
   * The first `limit` lines that contain `needle` ignoring case, with their
   * numbers counted from 1; matching both sides lowercased is enough.
   */
  grep: (path: string, needle: string, limit: number) => Promise<{ number: number; text: string }[]>
}

/** A handoff bundle and how the notes it creates describe themselves. */
export type Store = { host: Host; root: string; description: string; generatedBy: string }

export type RecentNote = { concept: string; slug: string; title: string; modified: string }

/** What a note holds, as the guidance and a compaction's note-writing prompt ask for it. */
export const NOTE_CONTENT =
  'The note has no fixed layout: write what you would need to pick the task up with nothing else. That is usually what the person asked for and what finished looks like; what is done and in progress, with exact file paths, branches, commands, identifiers and changes not committed yet; the rules the person set, in their own wording where it matters, and the decisions made; the next steps; and what is waiting on the person. Record only what the conversation shows, keep exact names, numbers and error messages, and leave out what the system prompt and instruction files already say.'

export const MAX_RECENT_NOTES = 5
const SEARCH_CANDIDATES = 500
export const MAX_SEARCH_RESULTS = 50

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
 * Writes the note, creating it first when it is missing. With `append`, the
 * body is added after what the note holds instead of replacing it.
 */
export async function writeNote(
  store: Store,
  concept: string,
  options: { title?: string; body: string; append?: boolean },
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
  const current = await readNote(store, concept)
  if (current === undefined) {
    throw new Error(`${concept} disappeared while it was written`)
  }
  const added = options.body.trim()
  const kept = options.append === true ? current.body.trim() : ''
  const text = [kept, added].filter(part => part !== '').join('\n\n')
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
      modified: utcMinute(mtimeMs),
      mtimeMs,
    })
  }

  return notes
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, MAX_RECENT_NOTES)
    .map(({ concept, slug, title, modified }) => ({ concept, slug, title, modified }))
}

export function utcMinute(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

/** What `handoff_read` answers for a note. */
export async function noteText(store: Store, concept: string): Promise<string> {
  const note = await readNote(store, concept)
  if (note === undefined) {
    return `${concept} has not been written yet.`
  }
  const title = await noteTitle(store, concept)
  const heading = title === '' ? concept : `${concept} (${title})`

  return `${heading}\n\n${note.body.trim() || '(empty)'}`
}

/** What `handoff_search` answers: the matching lines of the project's notes, grouped by note. */
export async function searchNotesText(store: Store, folder: string, query: string, limit: number): Promise<string> {
  if (!(await store.host.exists(`${store.root}/${folder}`))) {
    return 'No handoff note has been written in this project yet.'
  }
  const found = await okf(store, ['search', query, '--tag', HANDOFF_TAG, '--limit', String(SEARCH_CANDIDATES)])
  const hits = (Array.isArray(found) ? found : []).filter(
    (hit): hit is Record<string, unknown> & { id: string } =>
      isRecord(hit) && typeof hit.id === 'string' && hit.id.startsWith(`${folder}/`),
  )
  if (hits.length === 0) {
    return `No handoff note of this project matches "${query}".`
  }
  const shown = hits.slice(0, limit)
  const groups = new Map<string, string[]>()
  for (const hit of shown) {
    const where = hit.field === 'body' && typeof hit.line === 'number' ? `L${hit.line}` : String(hit.field ?? '')
    const lines = groups.get(hit.id) ?? []
    lines.push(`  ${where}: ${String(hit.excerpt ?? '').trim()}`)
    groups.set(hit.id, lines)
  }
  const parts: string[] = []
  for (const [concept, lines] of groups) {
    const title = await noteTitle(store, concept)
    parts.push(`- \`${concept.slice(folder.length + 1)}\`${title === '' ? '' : ` (${title})`}\n${lines.join('\n')}`)
  }
  const more = hits.length > shown.length ? `\n\n[${hits.length - shown.length} more matches: narrow the query or raise limit]` : ''

  return `${parts.join('\n')}${more}`
}
