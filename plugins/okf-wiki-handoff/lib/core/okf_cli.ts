// Finds the okf CLI, installing it with uv when it is missing, so the plugin works
// in a fresh cloud sandbox as well as on a machine that already has it.
//
// Shared by okf-wiki-handoff and okf-wiki-handoff-mod (through its `hooks/core` link), so it
// imports nothing: Node runs it in the plugin and the mod engine in the mod.

export const OKF_SOURCE = 'git+https://github.com/ryul99/okf-wiki.git'

const LOCATE_TIMEOUT_MS = 10_000
const INSTALL_TIMEOUT_MS = 240_000

export type Run = (argv: readonly string[], timeoutMs: number) => Promise<{ exitCode: number; stdout: string; stderr: string }>

/** Where okf runs from, and whether that folder is already on the PATH. */
export type OkfCommand = { path: string; isOnPath: boolean }

export type OkfSetup = (OkfCommand & { isInstalled: boolean }) | { error: string }

// `uv tool install` puts okf in uv's bin folder, which a fresh sandbox need not have on its PATH.
const LOCATE = [
  'found=$(command -v okf) && { printf "path\\n%s\\n" "$found"; exit 0; }',
  'dir=$(uv tool dir --bin 2>/dev/null) && [ -x "$dir/okf" ] && printf "uv\\n%s\\n" "$dir/okf"',
].join('\n')

function failure(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function locateOkf(run: Run): Promise<OkfCommand | undefined> {
  const ran = await run(['sh', '-c', LOCATE], LOCATE_TIMEOUT_MS).catch(() => undefined)
  const [where, path] = ran?.exitCode === 0 ? ran.stdout.split('\n') : []

  return path === undefined || path === '' ? undefined : { path, isOnPath: where === 'path' }
}

/** Finds okf, installing it from its repository with `uv tool install` when it is not there. */
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

/** The folder that holds okf, to put on the PATH of the shells the agent starts. */
export function okfFolder(path: string): string {
  return path.slice(0, path.lastIndexOf('/')) || '/'
}

/**
 * The line for Claude Code's `CLAUDE_ENV_FILE` that lets the agent's shells, and
 * so the okf-wiki skill, find an okf that uv put off the PATH.
 */
export function pathExport(found: OkfCommand): string | undefined {
  if (found.isOnPath) {
    return undefined
  }

  return `export PATH='${okfFolder(found.path).replaceAll("'", `'\\''`)}':"$PATH"\n`
}
