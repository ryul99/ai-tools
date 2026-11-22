import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import { parseCommand } from './shell.ts'

export const READ_ONLY_TOOLS = new Set(['read', 'grep', 'find', 'ls'])
const FILE_WRITE_TOOLS = new Set(['write', 'edit'])

const PROTECTED_DIRS = new Set(['.git', '.pi', '.claude', '.codex', '.agents', '.vscode', '.idea', '.husky', '.devcontainer', '.github'])
const PROTECTED_FILES = [/^\.env(\..*)?$/, /^\.npmrc$/, /^\.pypirc$/, /^\.netrc$/, /^\.mcp\.json$/, /^\.gitmodules$/, /^\.gitattributes$/, /^\.envrc$/, /^\.tool-versions$/, /^\.mise\.toml$/]
// Default macOS and Windows file systems ignore case, so `.GIT/hooks` is `.git/hooks` there.
const normalizeName = (name: string) => name.toLowerCase()

const READ_ONLY_COMMANDS = new Set([
  'basename', 'cat', 'cut', 'date', 'df', 'diff', 'dirname', 'du', 'echo', 'false', 'file', 'grep', 'head', 'id',
  'ls', 'nl', 'printf', 'pwd', 'readlink', 'realpath', 'rg', 'stat', 'tail', 'test', 'tr', 'tree', 'true', 'type',
  'uname', 'uniq', 'wc', 'which', 'whoami', '[',
])
const READ_ONLY_GIT = new Set(['blame', 'cat-file', 'describe', 'diff', 'grep', 'log', 'ls-files', 'ls-tree', 'rev-parse', 'shortlog', 'show', 'status'])
const FIND_WRITING_FLAGS = /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/

// getopt and git accept unique prefixes of long options, so `--comp=sh` means `--compress-program=sh`.
function hasLongOption(args: string[], names: string[]): boolean {
  return args.some(arg => {
    if (!arg.startsWith('--') || arg === '--') {
      return false
    }
    const given = arg.slice(2).split('=')[0]
    return names.some(name => name.startsWith(given))
  })
}

// Short options can be bundled and take attached values (`-uoFILE`), so any cluster containing the
// letter counts. A value that happens to contain it only sends the command to review.
function hasShortOption(args: string[], letters: string): boolean {
  return args.some(arg => /^-[^-]/.test(arg) && [...letters].some(letter => arg.includes(letter)))
}

function operands(args: string[]): string[] {
  return args.filter(arg => !arg.startsWith('-'))
}

function isReadOnlyCommand(words: string[]): boolean {
  const [name, ...args] = words
  switch (name) {
    case 'git': {
      const [sub, ...rest] = args
      if (sub === undefined || !READ_ONLY_GIT.has(sub)) {
        return false
      }
      if (sub === 'grep' && (hasShortOption(rest, 'O') || hasLongOption(rest, ['open-files-in-pager']))) {
        return false
      }
      return !hasLongOption(rest, ['output', 'ext-diff', 'textconv', 'filters'])
    }
    case 'find':
      return !args.some(arg => FIND_WRITING_FLAGS.test(arg))
    case 'sort':
      return !hasShortOption(args, 'o') && !hasLongOption(args, ['output', 'compress-program'])
    case 'rg':
      return !hasLongOption(args, ['pre', 'hostname-bin'])
    case 'tree':
      return !hasShortOption(args, 'oR') && !hasLongOption(args, ['output'])
    case 'uniq':
      return operands(args).length <= 1
    case 'file':
      return !hasShortOption(args, 'C') && !hasLongOption(args, ['compile'])
    case 'date':
      // `-I` takes an optional attached value such as `-Iseconds`, which isn't `-s`.
      return !hasShortOption(args.filter(arg => !arg.startsWith('-I')), 's') && !hasLongOption(args, ['set'])
        && operands(args).every(arg => arg.startsWith('+'))
    default:
      return READ_ONLY_COMMANDS.has(name)
  }
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
  const parts = rel.split(sep).map(normalizeName)
  if (parts.some(part => PROTECTED_DIRS.has(part))) {
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
