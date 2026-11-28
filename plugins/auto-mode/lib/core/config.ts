import { readFileSync, statSync } from 'node:fs'

import type { ThinkingLevel } from '@earendil-works/pi-ai'
import { resolvePolicy } from './policy.ts'
import type { PolicySlots } from './policy.ts'
import { compileRules } from './rules.ts'
import type { ToolRules } from './rules.ts'

export type EffortLevel = 'off' | ThinkingLevel

const EFFORT_LEVELS: readonly EffortLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const DEFAULT_EFFORT: EffortLevel = 'low'

export interface AutoModeConfig {
  /** `provider/model-id` of the reviewer; the session model when unset. */
  model?: string
  /** Reasoning effort of the reviewer; defaults to `low`. */
  effort: EffortLevel
  rules: ToolRules
  policy: PolicySlots
  /** Problems found while loading, shown to the user. */
  warnings: string[]
}

const SLOT_KEYS = ['environment', 'allow', 'soft_deny', 'hard_deny'] as const
const RULE_KEYS = ['deny', 'ask', 'allow'] as const

function stringList(value: unknown, name: string, warnings: string[]): string[] | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    warnings.push(`"${name}" must be a list of strings; ignored.`)
    return undefined
  }
  return value
}

export function parseConfig(text: string | undefined): AutoModeConfig {
  const warnings: string[] = []
  let raw: Record<string, unknown> = {}
  if (text !== undefined && text.trim() !== '') {
    try {
      const parsed = JSON.parse(text)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('the top level must be an object')
      }
      raw = parsed
    } catch (error) {
      warnings.push(`Could not read the config (${error instanceof Error ? error.message : String(error)}); using defaults.`)
    }
  }

  let model: string | undefined
  if (typeof raw.model === 'string' && raw.model.trim() !== '') {
    model = raw.model.trim()
  } else if (raw.model !== undefined && raw.model !== null) {
    warnings.push('"model" must be "provider/model-id" or null; ignored.')
  }

  let effort: EffortLevel = DEFAULT_EFFORT
  if (typeof raw.effort === 'string' && EFFORT_LEVELS.includes(raw.effort as EffortLevel)) {
    effort = raw.effort as EffortLevel
  } else if (raw.effort !== undefined && raw.effort !== null) {
    warnings.push(`"effort" must be one of ${EFFORT_LEVELS.join(', ')} or null; ignored.`)
  }

  const rulesRaw = raw.rules !== null && typeof raw.rules === 'object' ? raw.rules as Record<string, unknown> : {}
  const { rules, ignored } = compileRules(Object.fromEntries(RULE_KEYS.map(key => [key, stringList(rulesRaw[key], `rules.${key}`, warnings)])))
  if (ignored.length > 0) {
    warnings.push(`Ignored rules that are malformed or broad enough to run arbitrary code: ${ignored.join(', ')}`)
  }

  const policy = resolvePolicy(Object.fromEntries(SLOT_KEYS.flatMap(key => {
    const value = stringList(raw[key], key, warnings)
    return value === undefined ? [] : [[key, value]]
  })))

  return { model, effort, rules, policy, warnings }
}

export class ConfigLoader {
  private cached: { stamp: string, config: AutoModeConfig } | undefined

  readonly path: string

  constructor(path: string) {
    this.path = path
  }

  load(): AutoModeConfig {
    let stamp = 'missing'
    try {
      const stat = statSync(this.path)
      stamp = `${stat.mtimeMs}:${stat.size}`
    } catch {}
    if (this.cached?.stamp !== stamp) {
      let text: string | undefined
      try {
        text = stamp === 'missing' ? undefined : readFileSync(this.path, 'utf8')
      } catch {
        stamp = 'unreadable'
      }
      this.cached = { stamp, config: parseConfig(text) }
    }
    return this.cached.config
  }
}
