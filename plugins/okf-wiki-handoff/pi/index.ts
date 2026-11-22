import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { getAgentDir, SessionManager, truncateHead, withFileMutationQueue } from '@earendil-works/pi-coding-agent'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

import { BUNDLE_NAME, DEFAULT_REMIND_TOKENS, errorText, HANDOFF_DIR, MARKER, nameConcept, noteConcept, noteName, parsePositive, projectKey, SLUG_PATTERN } from '../lib/core/common.ts'
import { HISTORY_TOOLS, runHistoryTool } from '../lib/core/history.ts'
import type { HistoryToolName, Locator } from '../lib/core/history.ts'
import { MAX_SEARCH_RESULTS, NOTE_CONTENT, NOTE_UPKEEP, noteText, noteTitle, readNote, savedText, searchNotesText, writeNote } from '../lib/core/notes.ts'
import type { Store } from '../lib/core/notes.ts'
import { locateOkf } from '../lib/core/okf_cli.ts'
import type { OkfCommand } from '../lib/core/okf_cli.ts'
import { createNodeHost, runCommand } from '../lib/node-host.ts'

const ID = 'okf-wiki-handoff'
const MAX_INJECTED_NOTE_CHARS = 8_000
const MISSING_OKF = 'Install okf (0.2.0 or newer), then reload Pi to enable handoff notes.'

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

function piProjectKey(cwd: string): string {
  return `${projectKey(cwd).slice(0, 96)}-${hash(cwd)}`
}

function conceptFor(key: string, id: string): string {
  return noteConcept(`${HANDOFF_DIR}/${key}`, SLUG_PATTERN.test(id) ? id : `session-${hash(id)}`)
}

function currentConcept(ctx: ExtensionContext): string {
  if (!ctx.sessionManager.getSessionFile()) {
    throw new Error('The current Pi session is not persisted, so it has no handoff note.')
  }

  return conceptFor(piProjectKey(ctx.cwd), ctx.sessionManager.getSessionId())
}

function locatorFor(ctx: ExtensionContext, signal?: AbortSignal): Locator {
  const sm = ctx.sessionManager
  const root = join(getAgentDir(), 'sessions')

  return {
    kind: 'pi', root, key: piProjectKey(ctx.cwd), sessionId: sm.getSessionId(),
    async listSessions(scope) {
      const sessions = scope === 'all'
        ? await SessionManager.listAll(undefined, signal)
        : await SessionManager.list(ctx.cwd, sm.getSessionDir(), undefined, signal)
      const found = sessions.filter(info => scope === 'all' || info.cwd === ctx.cwd).map(info => ({
        id: info.id, path: info.path, mtimeMs: info.modified.getTime(),
        key: piProjectKey(info.cwd), project: info.cwd,
      }))
      const path = sm.getSessionFile()
      const mtimeMs = path ? await host.mtimeMs(path) : undefined
      if (path && mtimeMs !== undefined && !found.some(info => info.path === path)) {
        found.push({ id: sm.getSessionId(), path, mtimeMs, key: piProjectKey(ctx.cwd), project: ctx.cwd })
      }

      return found
    },
  }
}

const host = createNodeHost()

function toolText(text: string) {
  const truncated = truncateHead(text)

  return {
    content: [{ type: 'text' as const, text: truncated.content + (truncated.truncated ? '\n[Output truncated; narrow your request.]' : '') }],
    details: undefined,
  }
}

function noteBody(text: string | undefined): string {
  if (text === undefined || text.trim() === '') {
    throw new Error('The note text must not be blank.')
  }

  return text
}

export default function (pi: ExtensionAPI) {
  let okf: OkfCommand | undefined
  const store: Store = {
    host: createNodeHost(async () => okf),
    root: join(getAgentDir(), BUNDLE_NAME),
    generatedBy: `process:${ID}`,
  }
  let restoreText: string | undefined
  let noteBaseline: number | undefined
  let guided = false
  const reminderInterval = Math.max(1, Math.trunc(parsePositive(process.env.OKF_HANDOFF_REMIND_TOKENS, DEFAULT_REMIND_TOKENS)))

  function requireOkf() {
    if (!okf) {
      throw new Error(MISSING_OKF)
    }
  }

  async function restore(ctx: ExtensionContext) {
    restoreText = undefined
    if (!okf || !ctx.sessionManager.getSessionFile()) {
      return
    }
    try {
      const body = (await readNote(store, currentConcept(ctx)))?.body.trim()
      if (body) {
        restoreText = body.length <= MAX_INJECTED_NOTE_CHARS
          ? body
          : `${body.slice(0, MAX_INJECTED_NOTE_CHARS)}\n[Clipped; read the full note with handoff_read.]`
      }
    } catch (error) {
      ctx.ui.notify(`${MARKER} Could not restore the note: ${errorText(error)}`, 'warning')
    }
  }

  pi.on('session_start', async (_event, ctx) => {
    okf = await locateOkf(runCommand)
    if (!okf && ctx.hasUI && pi.getActiveTools().includes('handoff_write')) {
      ctx.ui.notify(`${MARKER} ${MISSING_OKF}`, 'warning')
    }
    noteBaseline = ctx.getContextUsage()?.tokens ?? 0
    if (ctx.sessionManager.getBranch().some(entry => entry.type === 'compaction')) {
      await restore(ctx)
    }
  })

  pi.on('session_tree', async (_event, ctx) => {
    guided = false
    noteBaseline = undefined
    await restore(ctx)
  })

  pi.on('session_compact', async (_event, ctx) => {
    guided = false
    noteBaseline = undefined
    await restore(ctx)
  })

  pi.on('context', event => {
    const note = restoreText
    if (!note || !event.messages.some(message => message.role === 'compactionSummary')) {
      return
    }
    // Keep Pi's own summary and the stored transcript unchanged.
    return { messages: event.messages.map(message => message.role === 'compactionSummary'
      ? { ...message, summary: `${message.summary}\n\n${MARKER} Continue from the summary together with your handoff note:\n<handoff-note>\n${note}\n</handoff-note>` }
      : message) }
  })

  pi.on('before_agent_start', (_event, ctx) => {
    if (guided || !okf || !ctx.sessionManager.getSessionFile() || !pi.getActiveTools().includes('handoff_write')) {
      return
    }
    guided = true
    const content = `${MARKER} Keep this session's handoff note (\`${noteName(currentConcept(ctx))}\`) current in the language of the conversation. Use handoff_write to replace it, handoff_append to add to it, and handoff_read to review it. The note is restored alongside Pi's regular summary after compaction. ${NOTE_UPKEEP}\n\n${NOTE_CONTENT}`

    return { message: { customType: ID, content, display: false } }
  })

  pi.on('turn_end', (event, ctx) => {
    if (event.outcome !== 'completed' || !okf || !ctx.sessionManager.getSessionFile() || !pi.getActiveTools().includes('handoff_write')) {
      return
    }
    const tokens = ctx.getContextUsage()?.tokens
    if (tokens == null) {
      return
    }
    noteBaseline = Math.min(noteBaseline ?? tokens, tokens)
    if (tokens - noteBaseline < reminderInterval) {
      return
    }
    noteBaseline = tokens

    return { entries: [...event.entries, {
      type: 'custom_message', customType: ID, display: false,
      content: `${MARKER} Bring the session's handoff note up to date with handoff_write at the next useful point.`,
    }] }
  })

  pi.registerTool({
    name: 'handoff_read', label: 'Read handoff note',
    description: "Read the current Pi session's note, or another note by the name returned by handoff_search.",
    parameters: Type.Object({ note: Type.Optional(Type.String()) }),
    async execute(_id, { note }, _signal, _update, ctx) {
      requireOkf()
      const concept = note === undefined ? currentConcept(ctx) : nameConcept(note)
      if (!concept) {
        throw new Error('Pass a handoff note name as <project-key>/<slug>.')
      }

      return toolText(await noteText(store, concept))
    },
  })

  for (const append of [false, true]) {
    const name = append ? 'handoff_append' : 'handoff_write'
    const field = append ? 'text' : 'body'
    pi.registerTool({
      name, label: append ? 'Append to handoff note' : 'Write handoff note',
      description: append ? 'Append Markdown to the current Pi session note.' : 'Replace the current Pi session note with up-to-date Markdown.',
      parameters: Type.Object({ [field]: Type.String(), title: Type.Optional(Type.String()) }),
      async execute(_id, params, _signal, _update, ctx) {
        requireOkf()
        const concept = currentConcept(ctx)
        const chars = await withFileMutationQueue(join(store.root, 'index.md'), () =>
          writeNote(store, concept, { body: noteBody(params[field]), title: params.title?.trim() || undefined, append }),
        )
        noteBaseline = ctx.getContextUsage()?.tokens ?? noteBaseline
        if (ctx.sessionManager.getBranch().some(entry => entry.type === 'compaction')) {
          await restore(ctx)
        }

        return toolText(savedText(concept, { isAppend: append, chars }))
      },
    })
  }

  pi.registerTool({
    name: 'handoff_search', label: 'Search handoff notes',
    description: 'Find handoff notes in the current Pi project, or across every Pi project when all_projects is true.',
    parameters: Type.Object({
      query: Type.String(), all_projects: Type.Optional(Type.Boolean()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SEARCH_RESULTS })),
    }),
    async execute(_id, { query, all_projects, limit }, _signal, _update, ctx) {
      requireOkf()
      if (query.trim() === '') {
        throw new Error('Pass the text to find as query.')
      }

      return toolText(await searchNotesText(store, `${HANDOFF_DIR}/${piProjectKey(ctx.cwd)}`, query, limit ?? 20, all_projects))
    },
  })

  const descriptions: Record<HistoryToolName, string> = {
    history_list: 'Show the context windows of a Pi session, or list the sessions of a project.',
    history_search: 'Search original Pi prompts, replies, tool calls, and tool results by literal text, including compacted messages. Searches this project by default.',
    history_read: 'Read a page of the original Pi transcript around a line from history_search or history_list.',
  }
  for (const name of Object.keys(HISTORY_TOOLS) as HistoryToolName[]) {
    const spec = HISTORY_TOOLS[name]
    const properties: Record<string, unknown> = { ...spec.properties }
    delete properties.agent
    properties.session = {
      type: 'string',
      description: `A Pi session ID${name === 'history_read' ? '' : ', or "all" for every session in the selected scope'}. Defaults to ${name === 'history_search' ? '"all"' : 'the current session'}.`,
    }
    pi.registerTool({
      name, label: name.replace('_', ' '), description: descriptions[name],
      parameters: Type.Unsafe<Record<string, unknown>>({ type: 'object', properties, required: spec.required, additionalProperties: false }),
      async execute(_id, params, signal, _update, ctx) {
        const input = name === 'history_search' ? { session: 'all', ...params } : params

        return toolText(await runHistoryTool(name, host, locatorFor(ctx, signal), input, (id, key) =>
          okf ? noteTitle(store, conceptFor(key, id)) : Promise.resolve(''),
        ))
      },
    })
  }
}
