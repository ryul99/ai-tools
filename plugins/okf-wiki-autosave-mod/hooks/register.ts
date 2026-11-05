import type { EngineInterface, Register } from 'claude-code'

import { errorText } from './core/text.ts'
import { applyPlan, plannerContext } from './core/worklog.ts'
import type { EnvName, Host } from './core/worklog.ts'
import { forkPrompt, parsePlan } from './plan.ts'

const HOOK_PLUGIN_PREFIX = 'okf-wiki-autosave@'
// `unclassified` stays in so an origin the engine cannot attest still journals, as the hook version does.
const HUMAN_ORIGINS: ReadonlySet<string> = new Set(['composer', 'bridge', 'sdk', 'unclassified'])
const OKF_TIMEOUT_MS = 30_000

async function isHookVersionEnabled($: EngineInterface): Promise<boolean> {
  const plugins = await $.settings.read({ key: 'enabledPlugins' }).catch(() => undefined)
  if (typeof plugins !== 'object' || plugins === null) {
    return false
  }

  return Object.entries(plugins).some(
    ([id, isOn]) => id.startsWith(HOOK_PLUGIN_PREFIX) && isOn === true,
  )
}

async function run($: EngineInterface, argv: readonly string[], options: { cwd?: string; stdin?: string } = {}) {
  const ran = await $.process.run(argv, { ...options, timeoutMs: OKF_TIMEOUT_MS })
  if (ran.exitCode !== 0) {
    const detail = ran.stderr.trim() || ran.stdout.trim() || `exit ${ran.exitCode}`
    throw new Error(`${argv.slice(0, 2).join(' ')} failed: ${detail}`)
  }

  return ran
}

/** The engine lists the variables a mod reads, so each is read by its literal name. */
function envValue($: EngineInterface, name: EnvName): Promise<string | undefined> {
  switch (name) {
    case 'OKF_ROOT':
      return $.env.get('OKF_ROOT')
    case 'OKF_AUTOSAVE_WORKLOG_DIR':
      return $.env.get('OKF_AUTOSAVE_WORKLOG_DIR')
    case 'OKF_AUTOSAVE_WORKLOG_MIN_CONFIDENCE':
      return $.env.get('OKF_AUTOSAVE_WORKLOG_MIN_CONFIDENCE')
    case 'OKF_AUTOSAVE_WORKLOG_MAX_BYTES':
      return $.env.get('OKF_AUTOSAVE_WORKLOG_MAX_BYTES')
    case 'OKF_AUTOSAVE_DRY_RUN':
      return $.env.get('OKF_AUTOSAVE_DRY_RUN')
  }
}

function engineHost($: EngineInterface): Host {
  const stat = (path: string) => $.fs.stat(path, { resolve: true }).catch(() => undefined)

  return {
    async okf(root, args, stdin) {
      const ran = await $.process.run(['okf', '--root', root, '--format', 'json', ...args], {
        cwd: root,
        stdin,
        timeoutMs: OKF_TIMEOUT_MS,
      })
      if (ran.exitCode !== 0) {
        const detail = ran.stderr.trim() || ran.stdout.trim() || `exit ${ran.exitCode}`
        throw new Error(`okf ${args.join(' ')} failed: ${detail}`)
      }

      return ran.stdout.trim() === '' ? undefined : JSON.parse(ran.stdout)
    },
    env: name => envValue($, name),
    home: async () => (await $.env.get('HOME')) ?? '',
    realPath: async path => (await stat(path))?.realPath,
    async kind(path) {
      const found = await stat(path)

      // A link that leads nowhere counts as missing, as it does for the hook version.
      return found === undefined || (found.isLink && found.kind === 'other') ? undefined : found.kind
    },
    mtimeMs: async path => (await stat(path))?.mtimeMs,
    readText: path => $.fs.read(path),
    list: path => $.fs.list(path).then(
      entries => entries.map(entry => entry.name),
      () => [],
    ),
    async mkdir(path) {
      await run($, ['mkdir', '-p', path])
    },
    async remove(path) {
      await run($, ['rm', '-f', path])
    },
    async createNew(path, text) {
      // `set -C` makes the redirect fail on a file that exists, as an exclusive create does.
      const ran = await $.process.run(['sh', '-c', 'set -C; printf %s "$1" > "$2"', 'sh', text, path], {
        timeoutMs: OKF_TIMEOUT_MS,
      })
      if (ran.exitCode === 0) {
        return true
      }
      if (await $.fs.exists(path)) {
        return false
      }
      throw new Error(`cannot create ${path}: ${ran.stderr.trim() || `exit ${ran.exitCode}`}`)
    },
    async gitBranch(cwd) {
      const ran = await $.process.run(['git', 'branch', '--show-current'], { cwd, timeoutMs: 10_000 }).catch(() => undefined)
      const branch = ran?.stdout.trim()

      return ran?.exitCode === 0 && branch ? branch : undefined
    },
    lockOwner: () => 'okf-wiki-autosave-mod',
  }
}

async function journal($: EngineInterface, answer: string): Promise<void> {
  const host = engineHost($)
  const cwd = await $.session.cwd()
  const context = await plannerContext(host, cwd, answer)
  if (context.root === null || context.worklog_dir === null) {
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
  if (plan.worklog === null) {
    return
  }
  const logged = await applyPlan(host, cwd, `${await host.home()}/.cache/okf-wiki-autosave`, plan)
  if (logged !== undefined) {
    $.ui.toast(`OKF autosave: logged ${logged}`)
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
          $.ui.toast(`OKF autosave failed: ${errorText(error)}`)
        })
        .finally(() => {
          isRunning = false
          $.ui.status(undefined)
        })
    })

    return result
  })
}
