import type { EngineInterface, Register } from 'claude-code'

import { forkPrompt, parsePlan } from './plan'
import type { ApplyResult, PlannerContext } from './plan'

const HOOK_PLUGIN_PREFIX = 'okf-wiki-autosave@'
// `unclassified` stays in so an origin the engine cannot attest still journals, as the hook version does.
const HUMAN_ORIGINS: ReadonlySet<string> = new Set(['composer', 'bridge', 'sdk', 'unclassified'])
const SCRIPT_TIMEOUT_MS = 90_000

async function isHookVersionEnabled($: EngineInterface): Promise<boolean> {
  const plugins = await $.settings.read({ key: 'enabledPlugins' }).catch(() => undefined)
  if (typeof plugins !== 'object' || plugins === null) {
    return false
  }

  return Object.entries(plugins).some(
    ([id, isOn]) => id.startsWith(HOOK_PLUGIN_PREFIX) && isOn === true,
  )
}

async function runScript<T>(
  $: EngineInterface,
  args: readonly string[],
  stdin: string,
  cwd: string,
): Promise<T> {
  const script = `${$.plugin.root}/scripts/okf_autosave.py`
  const ran = await $.process.run(['python3', script, ...args], {
    cwd,
    stdin,
    timeoutMs: SCRIPT_TIMEOUT_MS,
  })
  let output: unknown
  try {
    output = JSON.parse(ran.stdout)
  } catch {
    throw new Error(ran.stderr.trim() || `okf_autosave.py exited with ${ran.exitCode}`)
  }
  if (typeof output === 'object' && output !== null && 'error' in output) {
    throw new Error(String(output.error))
  }

  return output as T
}

async function journal($: EngineInterface, answer: string): Promise<void> {
  const cwd = await $.session.cwd()
  const context = await runScript<PlannerContext>($, ['context', '--cwd', cwd], answer, cwd)
  if (context.root === null || !context.worklog_dir) {
    return
  }
  const reply = await $.model.fork({ prompt: forkPrompt(context) })
  if (!reply.isAnswered) {
    if (reply.reason !== 'nothing-to-fork' && reply.reason !== 'aborted') {
      $.ui.toast(`OKF autosave failed: the planner call ended with ${reply.reason}`)
    }
    return
  }
  const plan = parsePlan(reply.text)
  if (plan === undefined) {
    $.ui.toast('OKF autosave failed: the planner reply was not an update plan')
    return
  }
  if (!plan.material_change) {
    return
  }
  const applied = await runScript<ApplyResult>(
    $,
    ['apply', '--cwd', cwd],
    JSON.stringify(plan),
    cwd,
  )
  if (applied.logged) {
    $.ui.toast(`OKF autosave: logged ${applied.logged}`)
  }
}

export const register: Register = on => {
  let isShadowed = false
  let isRunning = false
  let lastOrigin: string | undefined

  on('session.start', async ($, e, next) => {
    isShadowed = await isHookVersionEnabled($)
    if (isShadowed) {
      $.ui.toast('okf-wiki-autosave-mod is idle while the okf-wiki-autosave hook plugin is enabled')
    }

    return next(e)
  })

  on('prompt.submit', ($, e, next) => {
    // A notification folded into a running turn must not relabel the person's turn.
    if (e.turnId === undefined || HUMAN_ORIGINS.has(e.origin.kind)) {
      lastOrigin = e.origin.kind
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const isJournaled =
      !isShadowed &&
      !isRunning &&
      e.agentId === undefined &&
      e.reason === 'answer' &&
      lastOrigin !== undefined &&
      HUMAN_ORIGINS.has(lastOrigin)
    if (!isJournaled) {
      return result
    }
    isRunning = true
    const answer = e.answer
    // A timer outlives this dispatch, so the next prompt never waits on the journal.
    $.clock.after(0, () => {
      $.ui.status('OKF autosave: journaling')
      journal($, answer)
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          $.ui.toast(`OKF autosave failed: ${message}`)
        })
        .finally(() => {
          isRunning = false
          $.ui.status(undefined)
        })
    })

    return result
  })
}
