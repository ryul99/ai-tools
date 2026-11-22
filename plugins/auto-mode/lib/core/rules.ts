import { isAbsolute, relative, resolve } from 'node:path'

import { parseCommand } from './shell.ts'

export interface ToolRule {
  source: string
  tool: string
  pattern?: RegExp
}

export interface ToolRules {
  deny: ToolRule[]
  ask: ToolRule[]
  allow: ToolRule[]
}

const RULE_SYNTAX = /^([A-Za-z0-9_.:-]+)(?:\((.*)\))?$/s

// Allow rules that grant arbitrary code execution would let any command skip review.
const EXECUTORS = new Set([
  'bash', 'sh', 'zsh', 'fish', 'dash', 'python', 'python3', 'node', 'deno', 'bun', 'ruby', 'perl', 'php', 'lua',
  'npx', 'bunx', 'pnpx', 'uvx', 'uv', 'pipx', 'npm', 'pnpm', 'yarn', 'make', 'just', 'cargo', 'go',
  'env', 'sudo', 'doas', 'xargs', 'timeout', 'nice', 'nohup', 'exec', 'eval', 'command', 'time', 'watch', 'ssh', 'docker', 'kubectl',
])

function globToRegExp(glob: string): RegExp {
  const body = glob.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')
  return new RegExp(`^${body}$`, 's')
}

export function parseRule(source: string): ToolRule | undefined {
  const match = source.trim().match(RULE_SYNTAX)
  if (!match) {
    return undefined
  }
  const [, tool, pattern] = match
  return { source, tool, pattern: pattern === undefined || pattern.trim() === '' ? undefined : globToRegExp(pattern.trim()) }
}

/** True for an allow rule broad enough to run arbitrary code, which auto mode sets aside. */
export function isBroadAllowRule(source: string): boolean {
  const rule = parseRule(source)
  if (!rule || rule.tool !== 'bash') {
    return false
  }
  const pattern = source.trim().match(RULE_SYNTAX)?.[2]?.trim() ?? ''
  if (pattern === '' || pattern.startsWith('*')) {
    return true
  }
  const command = pattern.split(/\s+/)[0].replace(/\*$/, '')
  return EXECUTORS.has(command) && pattern.includes('*')
}

export function compileRules(raw: { deny?: string[], ask?: string[], allow?: string[] }): { rules: ToolRules, ignored: string[] } {
  const ignored: string[] = []
  const compile = (sources: string[] = [], dropBroad = false) => sources.flatMap(source => {
    const rule = parseRule(source)
    if (!rule || (dropBroad && isBroadAllowRule(source))) {
      ignored.push(source)
      return []
    }
    return [rule]
  })
  return { rules: { deny: compile(raw.deny), ask: compile(raw.ask), allow: compile(raw.allow, true) }, ignored }
}

function targetsOf(cwd: string, toolName: string, input: Record<string, unknown>): { all: string[], parts: string[] } | undefined {
  if (toolName === 'bash') {
    if (typeof input.command !== 'string') {
      return undefined
    }
    const parsed = parseCommand(input.command)
    const parts = parsed.segments.map(words => words.join(' '))
    return { all: [input.command.trim(), ...parts], parts: parsed.opaque ? [] : parts }
  }
  if (typeof input.path === 'string') {
    const absolute = resolve(cwd, input.path)
    const rel = relative(resolve(cwd), absolute)
    const shown = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? rel : absolute
    return { all: [shown, absolute], parts: [shown] }
  }
  return { all: [], parts: [] }
}

function matches(rule: ToolRule, toolName: string, target: string | undefined): boolean {
  return rule.tool === toolName && (rule.pattern === undefined || (target !== undefined && rule.pattern.test(target)))
}

export type RuleDecision = 'deny' | 'ask' | 'allow' | undefined

export function evaluateRules(rules: ToolRules, cwd: string, toolName: string, input: Record<string, unknown>): { decision: RuleDecision, rule?: string } {
  const targets = targetsOf(cwd, toolName, input)
  const anyMatch = (list: ToolRule[]) => list.find(rule =>
    rule.pattern === undefined ? rule.tool === toolName : (targets?.all ?? []).some(target => matches(rule, toolName, target)))

  const denied = anyMatch(rules.deny)
  if (denied) {
    return { decision: 'deny', rule: denied.source }
  }
  const asked = anyMatch(rules.ask)
  if (asked) {
    return { decision: 'ask', rule: asked.source }
  }
  const parts = targets?.parts ?? []
  if (toolName === 'bash') {
    if (parts.length === 0) {
      return { decision: undefined }
    }
    const used = parts.map(part => rules.allow.find(rule => matches(rule, toolName, part)))
    return used.every(Boolean) ? { decision: 'allow', rule: used.map(rule => rule!.source).join(', ') } : { decision: undefined }
  }
  const allowed = rules.allow.find(rule => rule.pattern === undefined ? rule.tool === toolName : parts.some(part => matches(rule, toolName, part)))
  return allowed ? { decision: 'allow', rule: allowed.source } : { decision: undefined }
}
