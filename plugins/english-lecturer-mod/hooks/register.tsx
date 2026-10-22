import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptSubmitInput, Register } from 'claude-code'

import type { LessonView } from '../types'
import { lessonPrompt, parseLesson } from './lesson'

const COMMAND = 'english-lecturer'
const ENABLED_KEY = 'enabled'
const HOOK_PLUGIN_PREFIX = 'english-lecturer@'
const HUMAN_ORIGINS: ReadonlySet<string> = new Set(['composer', 'bridge'])
const LESSON_TIMEOUT_MS = 60_000

const lesson = atom({ plugin: 'english-lecturer-mod', key: 'lesson' } as const, null)

async function isEnabled($: EngineInterface): Promise<boolean> {
  return (await $.store.get(ENABLED_KEY)) !== false
}

// Running next to the hook version would teach every prompt twice.
async function isHookVersionEnabled($: EngineInterface): Promise<boolean> {
  const plugins = await $.settings.read({ key: 'enabledPlugins' }).catch(() => undefined)
  if (typeof plugins !== 'object' || plugins === null) {
    return false
  }

  return Object.entries(plugins).some(
    ([id, isOn]) => id.startsWith(HOOK_PLUGIN_PREFIX) && isOn === true,
  )
}

function isTeachable(e: PromptSubmitInput): boolean {
  return (
    e.command === undefined &&
    e.isMeta !== true &&
    HUMAN_ORIGINS.has(e.origin.kind) &&
    e.text.trim() !== ''
  )
}

async function teach($: EngineInterface, text: string, ticket: number, model: string) {
  $.ui.status('English lecturer: reviewing your prompt')
  try {
    const reply = await $.model.complete({
      model,
      prompt: lessonPrompt(text),
      effort: 'low',
      timeoutMs: LESSON_TIMEOUT_MS,
    })
    const parsed = reply.isAnswered ? parseLesson(reply.text) : undefined
    const view: LessonView =
      parsed !== undefined
        ? { ticket, status: 'ready', lesson: parsed }
        : {
            ticket,
            status: 'failed',
            reason: reply.isAnswered ? 'the reply was not a lesson' : reply.reason,
          }
    await update($, lesson, current => (current?.ticket === ticket ? view : current))
  } finally {
    $.ui.status(undefined)
  }
}

export const register: Register = (on, options) => {
  const model = String(options.model ?? 'haiku')
  let isShadowed = false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Turn English lessons on or off',
      argumentHint: 'on|off',
    })
    isShadowed = await isHookVersionEnabled($)
    if (isShadowed) {
      $.ui.toast('english-lecturer-mod is idle while the english-lecturer hook plugin is enabled')
    }

    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const choice = e.args.trim()
    if (choice === 'on' || choice === 'off') {
      await $.store.set(ENABLED_KEY, choice === 'on')
      if (choice === 'off') {
        await update($, lesson, () => null)
      }

      return { text: `English lessons are ${choice}.` }
    }
    const state = (await isEnabled($)) ? 'on' : 'off'

    return { text: `English lessons are ${state}. Usage: /${COMMAND} on|off` }
  })

  on('prompt.submit', async ($, e, next) => {
    if (isShadowed || !isTeachable(e) || !(await isEnabled($))) {
      return next(e)
    }
    const ticket = await $.clock.now()
    await update($, lesson, () => ({ ticket, status: 'pending' }))
    // A timer outlives this dispatch, so pressing Esc on the turn does not cut the lesson.
    $.clock.after(0, () => {
      void teach($, e.text, ticket, model)
    })

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const view = await read($, lesson)
    if (e.props.hasSurvey || view === null) {
      return next(e)
    }
    const { Box, Button, Text } = $.ui.resolve(e)
    const dismiss = (
      <Button key="dismiss" label="Dismiss" onPress={() => update($, lesson, () => null)} />
    )

    if (view.status === 'pending') {
      return <Text dimColor>English lecturer: reviewing your prompt...</Text>
    }
    if (view.status === 'failed') {
      return (
        <Box gap={1}>
          <Text dimColor>English lecturer could not write a lesson: {view.reason}</Text>
          {dismiss}
        </Box>
      )
    }
    const { enhancedPrompt, hasCorrections, corrections, tip } = view.lesson
    if (!hasCorrections) {
      return (
        <Box gap={1}>
          <Text>Tip: {tip}</Text>
          {dismiss}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Text bold>{enhancedPrompt}</Text>
        {corrections.map(item => (
          <Box flexDirection="column">
            <Text>
              - {item.category}: {item.original} → <Text color="green">{item.suggestion}</Text>
            </Text>
            <Text dimColor>  {item.explanation}</Text>
          </Box>
        ))}
        <Text>Tip: {tip}</Text>
        <Box gap={1}>
          <Button
            key="copy"
            label="Copy rewrite"
            onPress={() => $.ui.copy({ text: enhancedPrompt, surface: e.surface })}
          />
          {dismiss}
        </Box>
      </Box>
    )
  })
}
