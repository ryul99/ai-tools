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
export type Store = { host: Host; root: string; generatedBy: string }

/** What a note holds, as the guidance and a compaction's note-writing prompt ask for it. */
export const NOTE_CONTENT =
  "The note has no fixed layout: write what you would need to pick the task up with nothing else, such as the goal and what finished looks like, the state of the work including what is uncommitted or waiting on the person, the person's rules in their own wording, the decisions made and the next steps. Record only what the conversation shows, keep names, numbers and error messages exact, and leave out what your instructions already say."

/**
 * How a note is kept while the work goes on. A compaction's note-writing prompt
 * leaves it out: it asks for the whole note at once, with nothing to correct.
 */
export const NOTE_UPKEEP =
  'It says where the task stands now and is not a log: when something in it stops being true or stops mattering for the work ahead, change or remove it instead of adding a correction after it.'

const SEARCH_CANDIDATES = 500
export const MAX_SEARCH_RESULTS = 50
const MAX_LINES_PER_NOTE = 3
// The heading already shows the title, and the other fields hold nearly the same text in every handoff note,
// so a line for them would only take the place of a body line.
const UNINFORMATIVE_FIELDS = new Set(['id', 'type', 'title', 'tags', 'description'])

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
 * body is added after what the note holds instead of replacing it. Resolves
 * the length of the note's body in characters.
 */
export async function writeNote(
  store: Store,
  concept: string,
  options: { title?: string; body: string; append?: boolean },
): Promise<number> {
  if (!(await store.host.exists(notePath(store, concept)))) {
    await ensureBundle(store)
    await okf(store, [
      'new',
      concept,
      '--type',
      HANDOFF_TYPE,
      '--title',
      options.title ?? `Handoff ${new Date().toISOString().slice(0, 10)}`,
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

  return text.length
}

/** What `handoff_write` and `handoff_append` answer. The size is there for the agent to judge when the note needs tidying. */
export function savedText(concept: string, options: { isAppend: boolean; chars: number }): string {
  return `${options.isAppend ? 'Appended to' : 'Saved'} ${concept}. The note is now ${options.chars.toLocaleString('en-US')} characters.`
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

/** What `handoff_search` answers: the project's matching notes, most relevant first, each with its best matching lines. */
export async function searchNotesText(store: Store, folder: string, query: string, limit: number): Promise<string> {
  if (!(await store.host.exists(`${store.root}/${folder}`))) {
    return 'No handoff note has been written in this project yet.'
  }
  const found = await okf(store, ['search', query, '--tag', HANDOFF_TAG, '--limit', String(SEARCH_CANDIDATES), '--with-matches'])
  const notes = (Array.isArray(found) ? found : []).filter(
    (concept): concept is Record<string, unknown> & { id: string; matches: unknown[] } =>
      isRecord(concept) && typeof concept.id === 'string' && concept.id.startsWith(`${folder}/`) && Array.isArray(concept.matches),
  )
  if (notes.length === 0) {
    return `No handoff note of this project matches "${query}".`
  }
  const parts = notes.slice(0, limit).map(({ id, title, matches }) => {
    const useful = matches.filter(isRecord).filter((match) => !UNINFORMATIVE_FIELDS.has(String(match.field)))
    const lines = useful.slice(0, MAX_LINES_PER_NOTE).map((match) => {
      const where = match.field === 'body' && typeof match.line === 'number' ? `L${match.line}` : String(match.field ?? '')

      return `  ${where}: ${String(match.excerpt ?? '').trim()}`
    })
    if (useful.length > lines.length) {
      lines.push(`  (+${useful.length - lines.length} more)`)
    }

    return [`- \`${id.slice(folder.length + 1)}\`${typeof title === 'string' ? ` (${title})` : ''}`, ...lines].join('\n')
  })
  const more = notes.length > parts.length ? `\n\n[${notes.length - parts.length} more notes: narrow the query or raise limit]` : ''

  return `${parts.join('\n')}${more}`
}
