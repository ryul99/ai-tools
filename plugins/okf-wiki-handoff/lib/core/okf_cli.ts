// Shared by okf-wiki-handoff and okf-wiki-handoff-mod (through its `hooks/core` link), so it
// imports nothing the mod engine lacks: only plain syntax, no Node builtins.

export const OKF_SOURCE = 'git+https://github.com/ryul99/okf-wiki.git'

const LOCATE_TIMEOUT_MS = 10_000
const INSTALL_TIMEOUT_MS = 240_000

export type Run = (argv: readonly string[], timeoutMs: number) => Promise<{ exitCode: number; stdout: string; stderr: string }>

export type OkfCommand = { path: string; isOnPath: boolean }

export type OkfSetup = (OkfCommand & { isInstalled: boolean }) | { error: string }

// `uv tool install` puts okf in uv's bin folder, which a fresh sandbox need not have on its PATH.

function firstLine(text: string): string | undefined {
  const line = text.split('\n')[0]?.trim()

  return line === '' ? undefined : line
}

// Windows has `where`, POSIX has `command -v`. Neither is guaranteed to exist,
// so both are tried and a failure is not an error. `where` goes first: on Windows a
// POSIX `sh` may exist (Git Bash) and report /c/... paths that CreateProcess cannot use.
async function probeOnPath(run: Run): Promise<string | undefined> {
  const windows = await run(['where', 'okf'], LOCATE_TIMEOUT_MS).catch(() => undefined)
  if (windows?.exitCode === 0) {
    // `where` may list several matches; prefer a real binary over a script shim,
    // which `run` cannot spawn without a shell.
    const lines = windows.stdout.split('\n').map(line => line.trim()).filter(line => line !== '')
    const preferred = lines.find(line => /\.exe$/i.test(line)) ?? lines[0]
    if (preferred !== undefined) {
      return preferred
    }
  }
  const posix = await run(['sh', '-c', 'command -v okf'], LOCATE_TIMEOUT_MS).catch(() => undefined)
  const found = posix?.exitCode === 0 ? firstLine(posix.stdout) : undefined

  // Git Bash prints /c/Users/... paths, which Windows cannot spawn; rewrite as C:/Users/...
  return found?.replace(/^\/([a-zA-Z])\//, '$1:/')
}

function uvInstalledOkf(dir: string): string[] {
  const base = dir.replace(/[/\\]+$/, '')

  return [`${base}/okf.exe`, `${base}/okf`]
}

export async function locateOkf(run: Run): Promise<OkfCommand | undefined> {
  const onPath = await probeOnPath(run)
  if (onPath !== undefined) {
    return { path: onPath, isOnPath: true }
  }
  const dir = await run(['uv', 'tool', 'dir', '--bin'], LOCATE_TIMEOUT_MS)
    .then(ran => (ran.exitCode === 0 ? firstLine(ran.stdout) : undefined))
    .catch(() => undefined)
  if (dir === undefined) {
    return undefined
  }
  // Verify a candidate by running it: no filesystem access available here, and the
  // mod engine may lack one. Any exit counts as found; only "cannot start" counts as missing.
  for (const candidate of uvInstalledOkf(dir)) {
    const probe = await run([candidate, '--help'], LOCATE_TIMEOUT_MS).catch(() => undefined)
    if (probe !== undefined) {
      return { path: candidate, isOnPath: false }
    }
  }

  return undefined
}

function failure(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function ensureOkf(run: Run, onInstall?: () => void): Promise<OkfSetup> {
  const found = await locateOkf(run)
  if (found !== undefined) {
    return { ...found, isInstalled: false }
  }
  onInstall?.()
  const ran = await run(['uv', 'tool', 'install', OKF_SOURCE], INSTALL_TIMEOUT_MS).catch((error: unknown) => ({
    exitCode: -1,
    stdout: '',
    stderr: failure(error),
  }))
  if (ran.exitCode !== 0) {
    const detail = ran.stderr.trim() || ran.stdout.trim() || `exit ${ran.exitCode}`

    return { error: `okf is not installed, and \`uv tool install ${OKF_SOURCE}\` failed: ${detail}` }
  }
  const installed = await locateOkf(run)

  return installed === undefined
    ? { error: 'uv installed okf, but it is neither on the PATH nor in `uv tool dir --bin`' }
    : { ...installed, isInstalled: true }
}

export function okfFolder(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))

  return cut === -1 ? '.' : cut === 0 ? path.slice(0, 1) : path.slice(0, cut)
}

/**
 * The line for Claude Code's `CLAUDE_ENV_FILE` that lets the agent's POSIX shells,
 * and so the okf-wiki skill, find an okf that uv put off the PATH.
 *
 * PowerShell ignores values containing slashes, so on Windows this line does nothing;
 * those sessions find okf either because uv's bin folder is on the user PATH
 * (`uv tool update-shell`) or not at all — the plugin's own okf calls use the
 * absolute path regardless.
 */
export function pathExport(found: OkfCommand): string | undefined {
  if (found.isOnPath) {
    return undefined
  }

  return `export PATH='${okfFolder(found.path).replaceAll("'", `'\\''`)}':"$PATH"\n`
}
