import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import { parseCommand } from './shell.ts'

export const READ_ONLY_TOOLS = new Set(['read', 'grep', 'find', 'ls'])
const FILE_WRITE_TOOLS = new Set(['write', 'edit'])

const PROTECTED_DIRS = new Set(['.git', '.pi', '.claude', '.codex', '.agents', '.vscode', '.idea', '.husky', '.devcontainer', '.github'])
const PROTECTED_FILES = [/^\.env(\..*)?$/, /^\.npmrc$/, /^\.pypirc$/, /^\.netrc$/, /^\.mcp\.json$/, /^\.gitmodules$/, /^\.gitattributes$/, /^\.envrc$/, /^\.tool-versions$/, /^\.mise\.toml$/]

const READ_ONLY_COMMANDS = new Set([
  'basename', 'cat', 'cut', 'date', 'df', 'diff', 'dirname', 'du', 'echo', 'false', 'file', 'grep', 'head', 'id',
  'ls', 'nl', 'printf', 'pwd', 'readlink', 'realpath', 'rg', 'stat', 'tail', 'test', 'tr', 'tree', 'true', 'type',
  'uname', 'uniq', 'wc', 'which', 'whoami', '[',
])
const READ_ONLY_GIT = new Set(['blame', 'cat-file', 'describe', 'diff', 'grep', 'log', 'ls-files', 'ls-tree', 'rev-parse', 'shortlog', 'show', 'status'])
const FIND_WRITING_FLAGS = /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/

function isReadOnlyCommand(words: string[]): boolean {
  const [name, ...args] = words
  if (name === 'git') {
    const sub = args[0]
    if (sub === undefined || !READ_ONLY_GIT.has(sub)) {
      return false
    }
    return !args.some(arg => arg.startsWith('--output') || arg === '--ext-diff' || arg.startsWith('--textconv'))
  }
  if (name === 'find') {
    return !args.some(arg => FIND_WRITING_FLAGS.test(arg))
  }
  if (name === 'sort') {
    return !args.some(arg => arg === '-o' || arg.startsWith('--output'))
  }
  if (name === 'rg') {
    return !args.some(arg => arg === '--pre' || arg.startsWith('--pre='))
  }
  if (name === 'tree') {
    return !args.some(arg => arg === '-o')
  }
  return READ_ONLY_COMMANDS.has(name) || name === 'sort'
}

export function isReadOnlyShell(command: string): boolean {
  const parsed = parseCommand(command)
  if (parsed.opaque || parsed.segments.length === 0) {
    return false
  }
  return parsed.segments.every(words => !words[0].includes('=') && isReadOnlyCommand(words))
}

function realPathOf(path: string): string {
  let existing = path
  const rest: string[] = []
  while (!existsSync(existing)) {
    const parent = dirname(existing)
    if (parent === existing) {
      return path
    }
    rest.unshift(basename(existing))
    existing = parent
  }
  return resolve(realpathSync(existing), ...rest)
}

function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? homedir() + path.slice(1) : path
}

/**
 * Where a file write lands relative to the working directory: `inside` when it can run without
 * review, `protected` for configuration and version-control files inside it, `outside` otherwise.
 * Symlinks are resolved so a link inside the project can't carry a write outside it.
 */
export function writeLocation(cwd: string, path: string): 'inside' | 'protected' | 'outside' {
  const root = realPathOf(resolve(cwd))
  const target = realPathOf(resolve(cwd, expandHome(path)))
  const rel = relative(root, target)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    return 'outside'
  }
  const parts = rel.split(sep)
  if (parts.slice(0, -1).some(part => PROTECTED_DIRS.has(part)) || PROTECTED_DIRS.has(parts[parts.length - 1])) {
    return 'protected'
  }
  return PROTECTED_FILES.some(pattern => pattern.test(parts[parts.length - 1])) ? 'protected' : 'inside'
}

export function isFastPath(cwd: string, toolName: string, input: Record<string, unknown>): boolean {
  if (READ_ONLY_TOOLS.has(toolName)) {
    return true
  }
  if (FILE_WRITE_TOOLS.has(toolName)) {
    return typeof input.path === 'string' && writeLocation(cwd, input.path) === 'inside'
  }
  if (toolName === 'bash') {
    return typeof input.command === 'string' && isReadOnlyShell(input.command)
  }
  return false
}
