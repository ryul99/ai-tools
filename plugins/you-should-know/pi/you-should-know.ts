import type { ExtensionAPI, ExtensionContext, Theme } from '@earendil-works/pi-coding-agent'
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import type { Component, TuiMouseEvent, TuiMouseEventResult } from '@earendil-works/pi-tui'

const ID = 'you-should-know'
const TIMEOUT_MS = 60_000
const REVIEW_EVERY = 3
const MAX_TOKENS = 400
const CONTEXT_CHARS = 10_000
const LINE_CHARS = 200
const DETAIL_CHARS = 600
const WIDGET_LINE_CHARS = 180
const WIDGET_PAD_X = 1
const BUTTON_GAP = 2

type Note = { line: string; detail?: string }
type ButtonAction = 'open' | 'fill' | 'dismiss'
type ButtonHitBox = { action: ButtonAction; startCol: number; endCol: number }

type EntryLike = {
  type: string
  message?: { role: string; content?: unknown }
}

function oneLine(text: string): string {
  return text.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim()
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`
}

function sentenceList(detail: string): string[] {
  return detail.split(/(?<=[.!?])\s+/).map(sentence => sentence.trim()).filter(Boolean).slice(0, 3)
}

function userText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(block => {
    if (block === null || typeof block !== 'object') return ''
    const b = block as Record<string, unknown>
    return b.type === 'text' ? String(b.text ?? '') : b.type === 'image' ? '[image]' : ''
  }).filter(Boolean).join('\n')
}

/**
 * The side request reads the user's words and the agent's replies, never tool
 * output: content the agent read (a web page with hidden instructions) must not
 * steer the guide.
 */
function projectContext(ctx: ExtensionContext): string {
  const entries = (ctx.sessionManager.getBranch() as EntryLike[]) ?? []
  const items: string[] = []
  let chars = 0
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    const role = entry?.type === 'message' ? entry.message?.role : undefined
    if (role !== 'user' && role !== 'assistant') continue
    const text = userText(entry?.type === 'message' ? entry.message?.content : undefined).trim()
    if (text === '') continue
    const cap = role === 'assistant' ? 2_000 : 1_500
    const clipped = text.slice(-cap)
    if (chars + clipped.length > CONTEXT_CHARS) continue
    items.push(`[${role}] ${clipped}`)
    chars += clipped.length + 20
  }
  return items.reverse().join('\n\n')
}

function sidePrompt(context: string): string {
  return `You are a knowledgeable guide observing a session between someone and their coding agent. The human is busy and constantly context-switching.

Look at the session below. Ask: is there anything the human should *really* know about this session — an important decision, a constraint, a non-obvious fact, or a trap — that they very likely (or clearly) do not yet understand? Prefer something with consequences. A decision with costs, a trap that would bite later, a non-obvious behavior. Passing facts mentioned in passing, inside a long answer, count.

Do not suggest something the human already seems to understand, or that they are already discussing in the session. Do not suggest routine, boring, or incidental details. When in doubt, say "none". This is a high bar. Do not invent facts beyond what is in the session. Do not copy wording from the session.

<session>
${context}
</session>

Reply with exactly:
Worth knowing: <one sentence, in the language of the session>
Detail: <two to four plain-language sentences in the language of the session, each on its own line>

If there is nothing that clears the bar, reply with the single word: none

The sentinel "Worth knowing:", "Detail:", and the word "none" stay in English; everything else is written in the session's language.`
}

function parseNote(reply: string): Note | undefined {
  const lines = reply.trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  if (lines.length === 0) return undefined
  if (/^none\.?$/i.test(lines[0])) return undefined
  const match = /^worth\s*knowing\s*:\s*(.+)$/is.exec(lines[0])
  if (!match) return undefined
  const line = truncate(oneLine(match[1]), LINE_CHARS)
  if (!line) return undefined
  const rest = lines.slice(1).join(' ').replace(/^detail\s*:\s*/i, '')
  const detail = rest === '' ? undefined : truncate(oneLine(rest), DETAIL_CHARS)
  return { line, detail }
}

function modelFor(ctx: ExtensionContext) {
  const override = process.env.YSN_PI_MODEL?.trim()
  if (!override) return ctx.model
  const slash = override.indexOf('/')
  return slash > 0 ? ctx.modelRegistry.find(override.slice(0, slash), override.slice(slash + 1)) : undefined
}

function quoteText(note: Note): string {
  const lines = ['> (side-agent note)', '>', `> Worth knowing: ${note.line}`]
  if (note.detail) {
    lines.push('>')
    for (const sentence of sentenceList(note.detail)) lines.push(`> ${sentence}`)
  }
  lines.push('')
  return lines.join('\n')
}

function createNoteWidget(
  note: Note,
  expanded: boolean,
  theme: Theme,
  onAction: (action: ButtonAction) => void,
): Component {
  let cachedWidth: number | undefined
  let cachedLines: string[] | undefined
  let actionRow = 0
  let buttons: ButtonHitBox[] = []
  let pressed: ButtonAction | undefined
  let pressedInside = false
  let handledRelease = false

  const invalidate = () => {
    cachedWidth = undefined
    cachedLines = undefined
  }

  const hitTest = (x: number, y: number): ButtonAction | undefined => {
    if (y !== actionRow) return undefined
    for (const box of buttons) {
      if (x >= box.startCol && x < box.endCol) return box.action
    }
    return undefined
  }

  const component: Component = {
    render(width: number): string[] {
      const safeWidth = Math.max(1, width)
      if (cachedLines && cachedWidth === safeWidth) return cachedLines

      const pad = safeWidth > WIDGET_PAD_X * 2 ? ' '.repeat(WIDGET_PAD_X) : ''
      const padWidth = pad.length
      const contentWidth = Math.max(1, safeWidth - padWidth * 2)
      const lines: string[] = []

      const headText = `${theme.fg('accent', 'Worth knowing')}${theme.fg('dim', ' · ')}${truncate(note.line, WIDGET_LINE_CHARS)}`
      for (const wrapped of wrapTextWithAnsi(headText, contentWidth)) {
        lines.push(truncateToWidth(`${pad}${wrapped}`, safeWidth))
      }

      if (expanded && note.detail) {
        for (const sentence of sentenceList(note.detail)) {
          const text = truncate(sentence, WIDGET_LINE_CHARS)
          for (const wrapped of wrapTextWithAnsi(text, contentWidth)) {
            lines.push(truncateToWidth(`${pad}${wrapped}`, safeWidth))
          }
        }
      }

      const specs: Array<{ action: ButtonAction; label: string; primary: boolean }> = expanded
        ? [
            { action: 'fill', label: '[ Fill ]', primary: true },
            { action: 'dismiss', label: '[ Dismiss ]', primary: false },
          ]
        : [
            { action: 'open', label: '[ Open ]', primary: true },
            { action: 'dismiss', label: '[ Dismiss ]', primary: false },
          ]

      actionRow = lines.length
      buttons = []
      let rowText = pad
      let col = padWidth

      for (let index = 0; index < specs.length; index += 1) {
        if (index > 0) {
          rowText += ' '.repeat(BUTTON_GAP)
          col += BUTTON_GAP
        }
        const spec = specs[index]
        const labelWidth = visibleWidth(spec.label)
        const startCol = col
        const endCol = Math.min(safeWidth, startCol + labelWidth)
        if (startCol < safeWidth && endCol > startCol) {
          buttons.push({ action: spec.action, startCol, endCol })
        }
        const styled = spec.primary
          ? theme.fg('accent', theme.bold(spec.label))
          : theme.fg('muted', spec.label)
        rowText += pressed === spec.action && pressedInside ? theme.inverse(styled) : styled
        col += labelWidth
      }

      lines.push(truncateToWidth(rowText, safeWidth, ''))
      cachedWidth = safeWidth
      cachedLines = lines
      return lines
    },

    handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
      if (!cachedLines || cachedWidth !== Math.max(1, event.width)) {
        component.render(event.width)
      }

      if (event.type === 'press') {
        if (event.button !== 'left') return undefined
        const hit = hitTest(event.x, event.y)
        if (!hit) return undefined
        pressed = hit
        pressedInside = true
        handledRelease = false
        invalidate()
        return { handled: true, capture: true, render: true }
      }

      if (event.type === 'drag') {
        if (!pressed) return undefined
        const nextInside = hitTest(event.x, event.y) === pressed
        if (nextInside !== pressedInside) {
          pressedInside = nextInside
          invalidate()
          return { handled: true, render: true }
        }
        return { handled: true, render: false }
      }

      if (event.type === 'release') {
        if (!pressed) return undefined
        const action = pressed
        const shouldTrigger = hitTest(event.x, event.y) === action
        pressed = undefined
        pressedInside = false
        // Alt-screen emits a synthetic click synchronously after release on the same cell.
        handledRelease = true
        queueMicrotask(() => {
          handledRelease = false
        })
        invalidate()
        if (shouldTrigger) onAction(action)
        return { handled: true, render: true }
      }

      if (event.type === 'click') {
        if (handledRelease) {
          handledRelease = false
          return { handled: true, render: false }
        }
        if (event.button !== 'left') return undefined
        const hit = hitTest(event.x, event.y)
        if (!hit) return undefined
        onAction(hit)
        return { handled: true, render: true }
      }

      return undefined
    },

    invalidate,
  }

  return component
}

export default function (pi: ExtensionAPI) {
  let enabled = true
  let latest: AbortController | undefined
  let note: Note | undefined
  let expanded = false
  const seen = new Set<string>()

  function noteKey(line: string): string {
    return line.toLowerCase().trim()
  }

  function handleWidgetAction(ctx: ExtensionContext, action: ButtonAction) {
    if (action === 'open') {
      if (!note || expanded) return
      expanded = true
      renderWidget(ctx)
      return
    }
    if (action === 'fill') {
      if (!note || !expanded) return
      fillNote(ctx)
      return
    }
    if (action === 'dismiss') {
      hideNote(ctx)
    }
  }

  function renderWidget(ctx: ExtensionContext) {
    if (!note) {
      ctx.ui.setWidget(ID, undefined)
      return
    }
    const currentNote = note
    const isExpanded = expanded
    ctx.ui.setWidget(ID, (_tui, theme) =>
      createNoteWidget(currentNote, isExpanded, theme, action => handleWidgetAction(ctx, action)),
    )
  }

  function hideNote(ctx: ExtensionContext) {
    latest?.abort()
    note = undefined
    expanded = false
    ctx.ui.setWidget(ID, undefined)
  }

  function fillNote(ctx: ExtensionContext) {
    if (!note) return
    const draft = ctx.ui.getEditorText() ?? ''
    if (draft.trim() !== '') {
      ctx.ui.notify('The prompt box has text in it. Clear it, then click Fill again.', 'warning')
      return
    }
    ctx.ui.setEditorText(quoteText(note))
    note = undefined
    expanded = false
    ctx.ui.setWidget(ID, undefined)
  }

  async function runSideRequest(ctx: ExtensionContext, request: AbortController) {
    try {
      const model = modelFor(ctx)
      if (!model) return
      const context = projectContext(ctx)
      if (context === '') return
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(TIMEOUT_MS)])
      const response = await ctx.modelRegistry.streamSimple(
        model,
        { messages: [{ role: 'user', content: sidePrompt(context) }] },
        { signal, maxTokens: MAX_TOKENS, reasoning: 'low', cacheRetention: 'none' },
      ).result()
      if (signal.aborted || response.stopReason !== 'stop') return
      const text = response.content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('\n')
      const parsed = parseNote(text)
      if (!parsed) return
      const key = noteKey(parsed.line)
      if (seen.has(key)) return
      seen.add(key)
      if (latest !== request) return
      note = parsed
      expanded = false
      renderWidget(ctx)
    } catch {
      // A side request must never interrupt the main conversation.
    } finally {
      if (latest === request && note === undefined) {
        ctx.ui.setWidget(ID, undefined)
      }
    }
  }

  pi.on('turn_end', async (event, ctx) => {
    if (!enabled || !ctx.hasUI || note !== undefined || latest !== undefined) return
    const index = event.turnIndex ?? 0
    if (index === 0 || index % REVIEW_EVERY !== 0) return
    const request = new AbortController()
    latest = request
    ctx.ui.setWidget(ID, ['You should know: checking the session…'])
    void runSideRequest(ctx, request).finally(() => {
      if (latest === request) latest = undefined
    })
  })

  pi.on('session_shutdown', () => {
    const request = latest
    latest = undefined
    request?.abort()
  })

  pi.registerCommand(ID, {
    description: 'Turn the note on or off, or interact with it',
    getArgumentCompletions: prefix => ['on', 'off', 'status', 'more', 'fill', 'dismiss'].filter(item => item.startsWith(prefix)).map(item => ({ value: item, label: item })),
    handler: async (args, ctx) => {
      const command = args.trim().split(/\s+/)[0] || 'status'
      if (command === 'on') {
        enabled = true
        ctx.ui.notify('You should know: on', 'info')
        return
      }
      if (command === 'off') {
        enabled = false
        hideNote(ctx)
        ctx.ui.notify('You should know: off', 'info')
        return
      }
      if (command === 'status') {
        ctx.ui.notify(`You should know: ${enabled ? 'on' : 'off'}${note ? ', a note is shown' : ''}`, 'info')
        return
      }
      if (command === 'more') {
        if (!note || expanded) return
        expanded = true
        renderWidget(ctx)
        return
      }
      if (command === 'fill') {
        if (!note || !expanded) {
          ctx.ui.notify('Open the note first (click Open or run /you-should-know more).', 'info')
          return
        }
        fillNote(ctx)
        return
      }
      if (command === 'dismiss') {
        hideNote(ctx)
        return
      }
      ctx.ui.notify('Usage: /you-should-know on|off|status|more|fill|dismiss', 'info')
    },
  })
}
