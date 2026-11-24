import { join } from 'node:path'

import { getAgentDir } from '@earendil-works/pi-coding-agent'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'

import { classify } from '../lib/core/classifier.ts'
import type { Complete, UsageLike, Verdict } from '../lib/core/classifier.ts'
import { ConfigLoader } from '../lib/core/config.ts'
import type { AutoModeConfig } from '../lib/core/config.ts'
import { isFastPath } from '../lib/core/fast-path.ts'
import { denyRules, systemPrompt } from '../lib/core/policy.ts'
import type { ContextFile } from '../lib/core/policy.ts'
import { evaluateRules } from '../lib/core/rules.ts'
import { actionKey, BlockedActions, DenialTracker } from '../lib/core/state.ts'
import { projectTranscript, renderAction, reviewRequest } from '../lib/core/transcript.ts'
import type { ToolDescription } from '../lib/core/transcript.ts'

const ID = 'auto-mode'
const REVIEW_TIMEOUT_MS = 90_000
const PROMPT_ACTION_LIMIT = 1_500

const RETRY_GUIDANCE = 'Do not try to reach the same effect another way. Take a safer approach that stays within what the user asked, or stop and ask the user to approve this exact action.'

interface Stats {
  reviews: number
  screenAllowed: number
  reviewed: number
  blocked: number
  unlabeled: number
  errors: number
  input: number
  cacheRead: number
  cacheWrite: number
}

function newStats(): Stats {
  return { reviews: 0, screenAllowed: 0, reviewed: 0, blocked: 0, unlabeled: 0, errors: 0, input: 0, cacheRead: 0, cacheWrite: 0 }
}

type ToolInfo = ReturnType<ExtensionAPI['getAllTools']>[number]

/**
 * The reviewer knows Pi's core tools, so only other tools get their description. Descriptions from
 * the project or from an external server can be written by someone other than the user, so they are
 * marked untrusted.
 */
function toolDescription(tool: ToolInfo | undefined): ToolDescription | undefined {
  if (tool === undefined || typeof tool.description !== 'string') {
    return undefined
  }
  const { source, scope, path } = tool.sourceInfo
  if (source === 'builtin' && path === `builtin:${tool.name}`) {
    return undefined
  }
  const external = path === 'builtin:mcp' || tool.namespace !== undefined
  const label = external ? 'MCP' : source === 'builtin' ? 'built-in extension' : source === 'sdk' ? 'SDK' : `${scope} extension`
  return { text: tool.description, source: label, trusted: !external && scope !== 'project' }
}

function reviewerModel(ctx: ExtensionContext, config: AutoModeConfig) {
  if (!config.model) {
    return ctx.model
  }
  const slash = config.model.indexOf('/')
  return slash > 0 ? ctx.modelRegistry.find(config.model.slice(0, slash), config.model.slice(slash + 1)) : undefined
}

function shortAction(toolName: string, input: unknown): string {
  const text = renderAction(toolName, input)
  return text.length > PROMPT_ACTION_LIMIT ? `${text.slice(0, PROMPT_ACTION_LIMIT)}…` : text
}

export default function (pi: ExtensionAPI) {
  const loader = new ConfigLoader(join(getAgentDir(), 'auto-mode.json'))
  const tracker = new DenialTracker()
  const blocked = new BlockedActions()
  let enabled = true
  let generation = 0
  let contextFiles: ContextFile[] = []
  let stats = newStats()
  let shownWarnings = ''
  let queue: Promise<unknown> = Promise.resolve()

  // Codemode scripts issue calls concurrently. One review or dialog at a time keeps dialogs from
  // stacking and lets each decision see the pause state left by the previous one.
  function serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task)
    queue = run.catch(() => undefined)
    return run
  }

  function updateStatus(ctx: ExtensionContext) {
    ctx.ui.setStatus(ID, enabled ? (tracker.paused ? 'auto mode (paused: asking you)' : 'auto mode') : undefined)
  }

  function loadConfig(ctx: ExtensionContext): AutoModeConfig {
    const config = loader.load()
    const warnings = config.warnings.join('\n')
    if (warnings !== shownWarnings) {
      shownWarnings = warnings
      if (warnings !== '') {
        ctx.ui.notify(`Auto mode config (${loader.path}):\n${warnings}`, 'warning')
      }
    }
    return config
  }

  async function askUser(ctx: ExtensionContext, toolName: string, input: unknown, why: string): Promise<boolean> {
    if (!ctx.hasUI) {
      return false
    }
    return ctx.ui.confirm('Auto mode: allow this action?', `${why}\n\n${shortAction(toolName, input)}`)
  }

  async function review(ctx: ExtensionContext, config: AutoModeConfig, toolCallId: string, toolName: string, input: unknown): Promise<Verdict> {
    const model = reviewerModel(ctx, config)
    if (!model) {
      return {
        decision: 'error',
        stage: 1,
        reason: config.model ? `Reviewer model "${config.model}" was not found.` : 'No model is selected for the session.',
        usage: [],
      }
    }
    const signal = AbortSignal.any([AbortSignal.timeout(REVIEW_TIMEOUT_MS), ...(ctx.signal ? [ctx.signal] : [])])
    const complete: Complete = async request => {
      const reply = await ctx.modelRegistry.streamSimple(model, {
        systemPrompt: request.systemPrompt,
        messages: request.messages as never,
      }, {
        signal,
        maxTokens: request.maxTokens,
        cacheRetention: 'short',
        sessionId: `${ctx.sessionManager.getSessionId()}:${ID}`,
      }).result()
      return reply as unknown as Awaited<ReturnType<Complete>>
    }
    const transcript = projectTranscript(ctx.sessionManager.getBranch() as never, toolCallId)
    const tool = toolDescription(pi.getAllTools().find(item => item.name === toolName))
    try {
      return await classify(
        complete,
        systemPrompt(config.policy, contextFiles),
        reviewRequest(transcript, toolName, input, tool),
        denyRules(config.policy),
      )
    } catch (error) {
      return { decision: 'error', stage: 1, reason: error instanceof Error ? error.message : String(error), usage: [] }
    }
  }

  function record(verdict: Verdict) {
    stats.reviews++
    if (verdict.decision === 'error') {
      stats.errors++
    } else if (verdict.stage === 1) {
      stats.screenAllowed++
    } else {
      stats.reviewed++
    }
    if (verdict.decision === 'block') {
      stats.blocked++
    } else if (verdict.decision === 'ask') {
      stats.unlabeled++
    }
    for (const usage of verdict.usage as UsageLike[]) {
      stats.input += usage.input
      stats.cacheRead += usage.cacheRead
      stats.cacheWrite += usage.cacheWrite
    }
  }

  pi.on('session_start', (_event, ctx) => {
    stats = newStats()
    updateStatus(ctx)
  })

  pi.on('before_agent_start', event => {
    contextFiles = event.systemPromptOptions.contextFiles ?? []
  })

  pi.on('tool_call', async (event, ctx) => {
    if (!enabled) {
      return undefined
    }
    const { toolName, toolCallId } = event
    const input = event.input as Record<string, unknown>
    const config = loadConfig(ctx)
    const key = actionKey(toolName, input)

    const ruled = evaluateRules(config.rules, ctx.cwd, toolName, input)
    if (ruled.decision === 'deny') {
      return { block: true, reason: `Blocked by the auto mode deny rule "${ruled.rule}". ${RETRY_GUIDANCE}` }
    }
    if (ruled.decision === 'ask') {
      return serialized(async () => {
        if (!enabled) {
          return undefined
        }
        if (ctx.signal?.aborted) {
          return { block: true, reason: 'The turn was cancelled before this action was approved.' }
        }
        return await askUser(ctx, toolName, input, `This action matches the ask rule "${ruled.rule}".`)
          ? undefined
          : { block: true, reason: `The user did not approve this action (ask rule "${ruled.rule}"). ${RETRY_GUIDANCE}` }
      })
    }
    if (ruled.decision === 'allow' || blocked.consumeApproval(key) || isFastPath(ctx.cwd, toolName, input)) {
      return undefined
    }
    const group = event.parentToolCallId?.split('/')[0]
    return serialized(() => decide(ctx, config, toolCallId, toolName, input, key, group))
  })

  async function decide(
    ctx: ExtensionContext,
    config: AutoModeConfig,
    toolCallId: string,
    toolName: string,
    input: Record<string, unknown>,
    key: string,
    group: string | undefined,
  ): Promise<{ block: true, reason: string } | undefined> {
    if (!enabled) {
      return undefined
    }
    if (ctx.signal?.aborted) {
      return { block: true, reason: 'The turn was cancelled before this action was reviewed.' }
    }

    if (tracker.paused && ctx.hasUI) {
      if (await askUser(ctx, toolName, input, 'Auto mode is paused after repeated blocks, so you decide. Approving resumes auto mode.')) {
        tracker.userApproved()
        updateStatus(ctx)
        return undefined
      }
      return { block: true, reason: `The user denied this action. ${RETRY_GUIDANCE}` }
    }

    const started = generation
    ctx.ui.setWorkingMessage('Auto mode is reviewing an action…')
    const verdict = await review(ctx, config, toolCallId, toolName, input)
    ctx.ui.setWorkingMessage()
    if (started !== generation || !enabled) {
      return undefined
    }
    record(verdict)

    if (verdict.decision === 'allow') {
      tracker.allowed()
      return undefined
    }

    if (verdict.decision === 'error') {
      if (await askUser(ctx, toolName, input, `Auto mode could not review this action: ${verdict.reason}`)) {
        return undefined
      }
      return { block: true, reason: `Auto mode could not review this action (${verdict.reason}) and it was not approved. ${RETRY_GUIDANCE}` }
    }

    if (verdict.decision === 'ask') {
      if (await askUser(ctx, toolName, input, `Auto mode's reviewer would block this without naming a rule it breaks: ${verdict.reason}`)) {
        return undefined
      }
      return { block: true, reason: `Auto mode's reviewer objected to this action (${verdict.reason}) and it was not approved. ${RETRY_GUIDANCE}` }
    }

    const label = verdict.rule ? ` [${verdict.rule}]` : ''
    blocked.add({ key, toolName, input, rule: verdict.rule, reason: verdict.reason })
    if (ctx.hasUI) {
      tracker.blocked(group)
    }
    if (tracker.paused && ctx.hasUI) {
      updateStatus(ctx)
      if (await askUser(ctx, toolName, input, `Auto mode blocked this${label}: ${verdict.reason}\nIt has blocked several actions, so it now asks you. Approving resumes auto mode.`)) {
        tracker.userApproved()
        updateStatus(ctx)
        return undefined
      }
    } else {
      ctx.ui.notify(`Auto mode blocked ${toolName}${label}: ${verdict.reason} (/auto-mode blocked to approve)`, 'warning')
    }
    return { block: true, reason: `Blocked by auto mode${label}: ${verdict.reason}\n${RETRY_GUIDANCE}` }
  }

  pi.registerCommand(ID, {
    description: 'Auto mode: on, off, status, or blocked (approve a blocked action once)',
    getArgumentCompletions: prefix => ['on', 'off', 'status', 'blocked']
      .filter(item => item.startsWith(prefix))
      .map(item => ({ value: item, label: item })),
    handler: async (args, ctx) => {
      const command = args.trim() || 'status'
      if (command === 'on' || command === 'off') {
        enabled = command === 'on'
        generation++
        if (enabled) {
          tracker.userApproved()
        }
        updateStatus(ctx)
        ctx.ui.notify(`Auto mode is ${command}.${enabled ? '' : ' Tool calls run without review.'}`, 'info')
        return
      }
      if (command === 'blocked') {
        const items = blocked.list()
        if (items.length === 0) {
          ctx.ui.notify('No recently blocked actions.', 'info')
          return
        }
        const labels = items.map((item, index) => `${index + 1}. ${shortAction(item.toolName, item.input).replace(/\s+/g, ' ').slice(0, 160)}`)
        const choice = await ctx.ui.select('Approve one blocked action to run once when the agent retries it', labels)
        const item = choice === undefined ? undefined : items[labels.indexOf(choice)]
        if (item) {
          blocked.approve(item.key)
          ctx.ui.notify('Approved once. Ask the agent to retry it.', 'info')
        }
        return
      }
      const config = loadConfig(ctx)
      const model = reviewerModel(ctx, config)
      ctx.ui.notify([
        `Auto mode: ${enabled ? (tracker.paused ? 'on, paused (asking you)' : 'on') : 'off'}`,
        `Reviewer: ${model ? `${model.provider}/${model.id}` : 'unavailable'}${config.model ? '' : ' (session model)'}`,
        `Config: ${loader.path}`,
        `Rules: ${config.rules.deny.length} deny, ${config.rules.ask.length} ask, ${config.rules.allow.length} allow`,
        `Blocks: ${tracker.consecutive} in a row, ${tracker.total} total`,
        `Reviews: ${stats.reviews} (${stats.screenAllowed} passed the screen, ${stats.reviewed} reviewed in depth, ${stats.blocked} blocked, ${stats.unlabeled} sent to you without a rule, ${stats.errors} failed)`,
        `Reviewer tokens: ${stats.input} input, ${stats.cacheRead} cache read, ${stats.cacheWrite} cache write`,
      ].join('\n'), 'info')
    },
  })
}
