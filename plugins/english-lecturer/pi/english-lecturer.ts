import type { ExtensionAPI, ExtensionContext, Theme } from '@earendil-works/pi-coding-agent'
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import type { Component, TuiMouseEvent, TuiMouseEventResult } from '@earendil-works/pi-tui'

import { lessonPrompt, parseLesson } from '../lib/core/lesson.ts'
import type { Lesson } from '../lib/core/lesson.ts'

const ID = 'english-lecturer'
const TIMEOUT_MS = 60_000
const WIDGET_PAD_X = 1
const CLOSE_LABEL = '[ Close ]'

function lessonModel(ctx: ExtensionContext) {
  const override = process.env.ENGLISH_LECTURER_PI_MODEL?.trim()
  if (!override) {
    return ctx.model
  }
  const slash = override.indexOf('/')

  return slash > 0 ? ctx.modelRegistry.find(override.slice(0, slash), override.slice(slash + 1)) : undefined
}

function displayLine(text: string): string {
  return text.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim().slice(0, 300)
}

function buildContentLines(lesson: Lesson | undefined, theme: Theme): string[] {
  if (!lesson) {
    return [`${theme.fg('accent', 'English lecturer')}${theme.fg('dim', ': ')}${theme.fg('muted', 'reviewing your prompt...')}`]
  }
  return [
    `${theme.fg('accent', 'English lecturer')}${theme.fg('dim', ': ')}${displayLine(lesson.enhancedPrompt)}`,
    ...(lesson.hasCorrections
      ? lesson.corrections.map(item => displayLine(`- ${item.original} → ${item.suggestion} (${item.explanation})`))
      : []),
    `${theme.fg('dim', 'Tip: ')}${displayLine(lesson.tip)}`,
  ]
}

function createLessonWidget(lesson: Lesson | undefined, theme: Theme, onClose: () => void): Component {
  let cachedWidth: number | undefined
  let cachedLines: string[] | undefined
  let actionRow = 0
  let closeStartCol = 0
  let closeEndCol = 0
  let pressed = false
  let pressedInside = false
  let handledRelease = false

  const invalidate = () => {
    cachedWidth = undefined
    cachedLines = undefined
  }

  const isOnClose = (x: number, y: number): boolean => y === actionRow && x >= closeStartCol && x < closeEndCol

  const component: Component = {
    render(width: number): string[] {
      const safeWidth = Math.max(1, width)
      if (cachedLines && cachedWidth === safeWidth) return cachedLines

      const pad = safeWidth > WIDGET_PAD_X * 2 ? ' '.repeat(WIDGET_PAD_X) : ''
      const padWidth = pad.length
      const contentWidth = Math.max(1, safeWidth - padWidth * 2)
      const lines: string[] = []

      for (const line of buildContentLines(lesson, theme)) {
        for (const wrapped of wrapTextWithAnsi(line, contentWidth)) {
          lines.push(truncateToWidth(`${pad}${wrapped}`, safeWidth))
        }
      }

      actionRow = lines.length
      closeStartCol = padWidth
      closeEndCol = Math.min(safeWidth, closeStartCol + visibleWidth(CLOSE_LABEL))
      const styled = theme.fg('muted', CLOSE_LABEL)
      const button = pressed && pressedInside ? theme.inverse(styled) : styled
      lines.push(truncateToWidth(`${pad}${button}`, safeWidth, ''))

      cachedWidth = safeWidth
      cachedLines = lines
      return lines
    },

    handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
      if (!cachedLines || cachedWidth !== Math.max(1, event.width)) {
        component.render(event.width)
      }

      if (event.type === 'press') {
        if (event.button !== 'left' || !isOnClose(event.x, event.y)) return undefined
        pressed = true
        pressedInside = true
        handledRelease = false
        invalidate()
        return { handled: true, capture: true, render: true }
      }

      if (event.type === 'drag') {
        if (!pressed) return undefined
        const nextInside = isOnClose(event.x, event.y)
        if (nextInside !== pressedInside) {
          pressedInside = nextInside
          invalidate()
          return { handled: true, render: true }
        }
        return { handled: true, render: false }
      }

      if (event.type === 'release') {
        if (!pressed) return undefined
        const shouldClose = isOnClose(event.x, event.y)
        pressed = false
        pressedInside = false
        // Alt-screen emits a synthetic click synchronously after release on the same cell.
        handledRelease = true
        queueMicrotask(() => {
          handledRelease = false
        })
        invalidate()
        if (shouldClose) onClose()
        return { handled: true, render: true }
      }

      if (event.type === 'click') {
        if (handledRelease) {
          handledRelease = false
          return { handled: true, render: false }
        }
        if (event.button !== 'left' || !isOnClose(event.x, event.y)) return undefined
        onClose()
        return { handled: true, render: true }
      }

      return undefined
    },

    invalidate,
  }

  return component
}

export default function (pi: ExtensionAPI) {
  let latest: AbortController | undefined
  let enabled = true

  function closeWidget(ctx: ExtensionContext) {
    latest?.abort()
    latest = undefined
    ctx.ui.setWidget(ID, undefined)
  }

  function showWidget(ctx: ExtensionContext, lesson: Lesson | undefined) {
    ctx.ui.setWidget(ID, (_tui, theme) => createLessonWidget(lesson, theme, () => closeWidget(ctx)))
  }

  function setEnabled(value: boolean, ctx: ExtensionContext) {
    enabled = value
    if (!value) {
      closeWidget(ctx)
      ctx.ui.notify('English lecturer: disable', 'info')
    } else {
      ctx.ui.notify('English lecturer: enable', 'info')
    }
  }

  pi.registerCommand('english-lecturer', {
    description: '/english-lecturer (enable/disable/close)',
    getArgumentCompletions: prefix => ['enable', 'disable', 'close']
      .filter(item => item.startsWith(prefix.toLowerCase()))
      .map(item => ({ value: item, label: item })),
    handler: async (args, ctx) => {
      const subcommand = args.trim().split(/\s+/)[0]?.toLowerCase()
      if (subcommand === 'enable') {
        setEnabled(true, ctx)
      } else if (subcommand === 'disable') {
        setEnabled(false, ctx)
      } else if (subcommand === 'close') {
        closeWidget(ctx)
      } else {
        ctx.ui.notify('Usage: /english-lecturer enable|disable|close', 'warning')
      }
    },
  })

  async function teach(ctx: ExtensionContext, text: string, request: AbortController) {
    try {
      const model = lessonModel(ctx)
      if (!model) {
        throw new Error('No lesson model available. Check the session model or ENGLISH_LECTURER_PI_MODEL (provider/model-id).')
      }
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(TIMEOUT_MS)])
      const response = await ctx.modelRegistry.streamSimple(model, {
        messages: [{ role: 'user', content: lessonPrompt(text, 'text'), timestamp: Date.now() }],
      }, { signal, maxTokens: 2_048, reasoning: 'low', cacheRetention: 'none' }).result()
      if (signal.aborted || response.stopReason !== 'stop') {
        throw new Error('The lesson request did not complete.')
      }
      const lesson = parseLesson(response.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'))
      if (!lesson) {
        throw new Error('The model did not return a lesson.')
      }
      if (latest === request) {
        showWidget(ctx, lesson)
      }
    } catch (error) {
      if (latest === request) {
        ctx.ui.setWidget(ID, undefined)
        ctx.ui.notify(`English lecturer: ${error instanceof Error ? error.message : 'Lesson unavailable.'}`, 'warning')
      }
    } finally {
      if (latest === request) {
        latest = undefined
      }
    }
  }

  pi.on('input', (event, ctx) => {
    const text = event.text.trim()
    if (!enabled || !ctx.hasUI || event.source === 'extension' || text === '' || text.startsWith('/')) {
      return
    }
    latest?.abort()
    const request = new AbortController()
    latest = request
    showWidget(ctx, undefined)
    void teach(ctx, text, request)
  })

  pi.on('session_shutdown', () => {
    const request = latest
    latest = undefined
    request?.abort()
  })
}
