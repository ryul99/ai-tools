import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { getAgentDir, SessionManager, SettingsManager, truncateHead, withFileMutationQueue } from '@earendil-works/pi-coding-agent'
import type { ExtensionAPI, ExtensionContext, SessionProjection } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

import { BUNDLE_NAME, DEFAULT_REMIND_TOKENS, errorText, HANDOFF_DIR, MARKER, nameConcept, noteConcept, noteName, parsePositive, projectKey, SLUG_PATTERN } from '../lib/core/common.ts'
import { HISTORY_TOOLS, runHistoryTool } from '../lib/core/history.ts'
import type { HistoryToolName, Locator } from '../lib/core/history.ts'
import { MAX_SEARCH_RESULTS, NOTE_CONTENT, NOTE_UPKEEP, noteText, noteTitle, readNote, savedText, searchNotesText, writeNote } from '../lib/core/notes.ts'
import type { Store } from '../lib/core/notes.ts'
import { locateOkf } from '../lib/core/okf_cli.ts'
import type { OkfCommand } from '../lib/core/okf_cli.ts'
import { createNodeHost, runCommand } from '../lib/node-host.ts'

import { CONTINUE_PROMPT, DEFAULT_MARGIN_PERCENT, FRESH_TOKENS, handoffSummary, keptHistory, refreshNote } from './compaction.ts'

const ID = 'okf-wiki-handoff'
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
  let resetRequested = false
  let noteBaseline: number | undefined
  let remindedAt: number | undefined
  let urgentSent = false
  const reminderInterval = parsePositive(process.env.OKF_HANDOFF_REMIND_TOKENS, DEFAULT_REMIND_TOKENS)
  const margin = parsePositive(process.env.OKF_HANDOFF_MARGIN_PERCENT, DEFAULT_MARGIN_PERCENT)
  const marginPercent = margin < 100 ? margin : DEFAULT_MARGIN_PERCENT

  function requireOkf() {
    if (!okf) {
      throw new Error(MISSING_OKF)
    }
  }

  function enabled(ctx: ExtensionContext) {
    return !!okf && !!ctx.sessionManager.getSessionFile() && pi.getActiveTools().includes('handoff_write')
  }

  function startWindow() {
    resetRequested = false
    noteBaseline = undefined
    remindedAt = undefined
    urgentSent = false
  }

  function save(concept: string, options: Parameters<typeof writeNote>[2]) {
    return withFileMutationQueue(join(store.root, 'index.md'), () => writeNote(store, concept, options))
  }

  async function noteForCompaction(
    ctx: ExtensionContext,
    projection: SessionProjection,
    options: { tokens?: number; instructions?: string; signal?: AbortSignal },
  ) {
    const concept = currentConcept(ctx)
    const current = (await readNote(store, concept))?.body.trim() ?? ''
    const fresh = options.tokens !== undefined && noteBaseline !== undefined && options.tokens - noteBaseline < FRESH_TOKENS
    if (current && fresh && !options.instructions?.trim()) return { body: current, usage: undefined }

    try {
      const plan = await refreshNote(ctx, projection, { ...options, current })
      await save(concept, plan)
      return plan
    } catch (error) {
      if (!current || options.signal?.aborted) throw error
      ctx.ui.notify(`${MARKER} Could not refresh the handoff note; using the saved note: ${errorText(error)}`, 'warning')
      return { body: current, usage: undefined }
    }
  }

  function contextLimits(ctx: ExtensionContext) {
    const usage = ctx.getContextUsage()
    if (!usage) return undefined
    const { enabled, reserveTokens } = SettingsManager.create(ctx.cwd, getAgentDir(), {
      projectTrusted: ctx.isProjectTrusted(),
    }).getCompactionSettings(ctx.model)
    return { ...usage, compactAt: enabled ? usage.contextWindow - reserveTokens : undefined }
  }

  pi.on('session_start', async (_event, ctx) => {
    okf = await locateOkf(runCommand)
    if (!okf && ctx.hasUI && pi.getActiveTools().includes('handoff_write')) {
      ctx.ui.notify(`${MARKER} ${MISSING_OKF}`, 'warning')
    }
  })

  pi.on('session_tree', startWindow)
  pi.on('session_compact', startWindow)
  pi.on('agent_settled', () => { resetRequested = false })

  pi.on('before_agent_start', (event, ctx) => {
    if (!enabled(ctx)) return
    const tools = pi.getActiveTools()
    const guidance = [
      `Keep this session's handoff note (\`${noteName(currentConcept(ctx))}\`) current in the language of the conversation. Use handoff_write to replace it, handoff_append to add to it, and handoff_read to review it. Compaction uses the note in place of Pi's default summary when possible. The original messages stay in the transcript. ${NOTE_UPKEEP}`,
      NOTE_CONTENT,
    ]
    if (tools.includes('context_remaining')) guidance.push('Use context_remaining to plan long steps against the remaining context budget.')
    if (tools.includes('new_context')) guidance.push('When little context remains or at a natural checkpoint late in the window, bring the note up to date, call new_context, and end with a one-line status. Work resumes automatically from the note.')
    event.systemPromptOptions.sections[ID] = `# Context management\n\n${guidance.join('\n\n')}`
  })

  pi.on('session_before_compact', async (event, ctx) => {
    if (!enabled(ctx)) return
    try {
      const projection = ctx.sessionManager.buildSessionProjection()
      const { tokensBefore, firstKeptEntryId } = event.preparation
      const note = await noteForCompaction(ctx, projection, {
        tokens: tokensBefore, instructions: event.customInstructions, signal: event.signal,
      })
      event.signal.throwIfAborted()
      const kept = keptHistory(projection, firstKeptEntryId, ctx.model?.contextWindow)
      return { compaction: {
        summary: handoffSummary(note.body, kept.prompt), firstKeptEntryId: kept.firstKeptEntryId,
        tokensBefore, usage: note.usage, details: { handoff: ID },
      } }
    } catch (error) {
      if (!event.signal.aborted) ctx.ui.notify(`${MARKER} Using Pi's default compaction: ${errorText(error)}`, 'warning')
    }
  })

  pi.on('agent_before_settle', async (event, ctx) => {
    if (!resetRequested) return
    resetRequested = false
    if (event.outcome !== 'completed' || !enabled(ctx)) return
    try {
      const signal = ctx.signal
      const note = await noteForCompaction(ctx, ctx.sessionManager.buildSessionProjection(), {
        tokens: ctx.getContextUsage()?.tokens ?? undefined, signal,
      })
      signal?.throwIfAborted()
      startWindow()
      return { entries: [...event.entries, {
        type: 'compaction', firstKeptEntryId: null, summary: handoffSummary(note.body), usage: note.usage,
        details: { handoff: ID },
      }, {
        type: 'custom_message', customType: ID, display: false, content: CONTINUE_PROMPT,
      }], continue: true }
    } catch (error) {
      ctx.ui.notify(`${MARKER} Could not start a fresh context: ${errorText(error)}`, 'warning')
    }
  })

  pi.on('turn_end', (event, ctx) => {
    if (event.outcome !== 'completed' || !enabled(ctx) || resetRequested) return
    const tokens = ctx.getContextUsage()?.tokens
    if (tokens == null) return
    noteBaseline = Math.min(noteBaseline ?? tokens, tokens)
    if (remindedAt !== undefined && tokens < remindedAt) remindedAt = undefined

    let content: string | undefined
    if (!urgentSent && pi.getActiveTools().includes('new_context')) {
      const limits = contextLimits(ctx)
      if (limits?.compactAt !== undefined && tokens >= limits.compactAt - limits.contextWindow * marginPercent / 100) {
        urgentSent = true
        const remaining = Math.max(0, limits.compactAt - tokens).toLocaleString('en-US')
        content = `About ${remaining} tokens remain before automatic compaction. Update the note, call new_context, and end with a one-line status.`
      }
    }
    if (!content && tokens - noteBaseline >= reminderInterval && (remindedAt === undefined || tokens - remindedAt >= reminderInterval)) {
      remindedAt = tokens
      content = 'Bring the session handoff note up to date with handoff_write at the next useful point.'
    }
    if (content) return { entries: [...event.entries, {
      type: 'custom_message', customType: ID, display: false, content: `${MARKER} ${content}`,
    }] }
  })

  pi.registerTool({
    name: 'context_remaining', label: 'Context remaining',
    description: 'Report the current context usage and remaining tokens before Pi automatic compaction.',
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, ctx) {
      const limits = contextLimits(ctx)
      if (!limits || limits.tokens == null) return toolText('Context usage is not available yet.')
      const { tokens, contextWindow, compactAt } = limits
      const format = (value: number) => value.toLocaleString('en-US')
      const used = `Context used: ${format(tokens)} of ${format(contextWindow)} tokens.`
      return toolText(compactAt === undefined ? `${used} Automatic compaction is off.`
        : `${used} Automatic compaction runs above ${format(compactAt)} tokens; about ${format(Math.max(0, compactAt - tokens))} tokens remain.`)
    },
  })

  pi.registerTool({
    name: 'new_context', label: 'Start fresh context',
    description: 'Continue from the handoff note in a fresh context after the current run settles. Update the note first, then end with a one-line status.',
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, ctx) {
      requireOkf()
      currentConcept(ctx)
      if (!enabled(ctx)) throw new Error('Enable handoff_write to start a fresh context.')
      resetRequested = true
      return toolText('A fresh context is scheduled. Once the note is current, end this run with a one-line status.')
    },
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
        const chars = await save(concept, { body: noteBody(params[field]), title: params.title?.trim() || undefined, append })
        noteBaseline = ctx.getContextUsage()?.tokens ?? noteBaseline
        remindedAt = undefined
        urgentSent = false

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
