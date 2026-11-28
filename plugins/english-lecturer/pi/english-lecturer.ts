import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'

import { lessonPrompt, parseLesson } from '../lib/core/lesson.ts'
import type { Lesson } from '../lib/core/lesson.ts'

const ID = 'english-lecturer'
const TIMEOUT_MS = 60_000

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

function lessonLines(lesson: Lesson): string[] {
  return [
    `English lecturer: ${displayLine(lesson.enhancedPrompt)}`,
    ...(lesson.hasCorrections
      ? lesson.corrections.map(item => displayLine(`- ${item.original} → ${item.suggestion} (${item.explanation})`))
      : []),
    `Tip: ${displayLine(lesson.tip)}`,
  ]
}

export default function (pi: ExtensionAPI) {
  let latest: AbortController | undefined
  let enabled = true

  function setEnabled(value: boolean, ctx: ExtensionContext) {
    enabled = value
    if (!value) {
      latest?.abort()
      latest = undefined
      ctx.ui.setWidget(ID, undefined)
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
        latest?.abort()
        latest = undefined
        ctx.ui.setWidget(ID, undefined)
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
        ctx.ui.setWidget(ID, lessonLines(lesson))
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
    ctx.ui.setWidget(ID, ['English lecturer: reviewing your prompt...'])
    void teach(ctx, text, request)
  })

  pi.on('session_shutdown', () => {
    const request = latest
    latest = undefined
    request?.abort()
  })
}
