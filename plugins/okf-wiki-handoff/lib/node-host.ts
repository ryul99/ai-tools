import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import type { DirEntry, Host } from './core/notes.ts'
import { locateOkf } from './core/okf_cli.ts'
import type { OkfCommand } from './core/okf_cli.ts'

const OKF_TIMEOUT_MS = 30_000

export function run(
  argv: readonly string[],
  options: { cwd?: string; stdin?: string; timeoutMs?: number },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const [command, ...args] = argv
    if (command === undefined) {
      reject(new Error('no command to run'))

      return
    }
    const child = spawn(command, args, { cwd: options.cwd, timeout: options.timeoutMs ?? OKF_TIMEOUT_MS, stdio: 'pipe' })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', reject)
    child.on('close', (code, signal) => {
      resolve({
        exitCode: code ?? (signal === null ? 1 : 128),
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    })
    child.stdin.on('error', reject)
    child.stdin.end(options.stdin ?? '')
  })
}

export const runCommand = (argv: readonly string[], timeoutMs: number) => run(argv, { timeoutMs })

async function isDirectory(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined))?.isDirectory() === true
}

async function* fileLines(path: string): AsyncGenerator<string> {
  const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Number.POSITIVE_INFINITY })
  try {
    yield* lines
  } finally {
    lines.close()
  }
}

export async function lineCount(path: string): Promise<number> {
  let count = 0
  for await (const chunk of createReadStream(path)) {
    for (const byte of chunk as Buffer) {
      if (byte === 0x0a) {
        count += 1
      }
    }
  }

  return count
}

export function createNodeHost(getOkf: () => Promise<OkfCommand | undefined> = () => locateOkf(runCommand)): Host {
  return {
    async okf(args, stdin) {
      const executable = (await getOkf())?.path
      if (executable === undefined) {
        throw new Error('okf command is not available')
      }
      const rootIndex = args.indexOf('--root')
      const root = rootIndex === -1 ? undefined : args[rootIndex + 1]
      const ran = await run([executable, '--format', 'json', ...args], {
        cwd: root !== undefined && (await isDirectory(root)) ? root : undefined,
        stdin,
      })
      if (ran.exitCode !== 0) {
        const detail = ran.stderr.trim() || ran.stdout.trim() || `exit ${ran.exitCode}`
        const command = args.slice(rootIndex === -1 ? 0 : 2, (rootIndex === -1 ? 0 : 2) + 2).join(' ')
        throw new Error(`okf ${command} failed: ${detail}`)
      }
      if (ran.stdout.trim() === '') {
        return undefined
      }
      try {
        return JSON.parse(ran.stdout)
      } catch {
        throw new Error('okf returned invalid JSON')
      }
    },
    exists: async path => (await stat(path).catch(() => undefined)) !== undefined,
    mtimeMs: async path => (await stat(path).catch(() => undefined))?.mtimeMs,
    async list(path) {
      const entries = await readdir(path, { withFileTypes: true }).catch(() => [])
      const listed: DirEntry[] = []
      for (const entry of entries) {
        const kind = entry.isFile() ? 'file' : entry.isDirectory() ? 'dir' : 'other'
        const mtimeMs = kind === 'file' ? ((await stat(join(path, entry.name)).catch(() => undefined))?.mtimeMs ?? 0) : 0
        listed.push({ name: entry.name, kind, mtimeMs })
      }

      return listed
    },
    readText: path => readFile(path, 'utf8').catch(() => undefined),
    lineCount,
    async grep(path, needle, limit) {
      const lowered = needle.toLowerCase()
      const hits: { number: number; text: string }[] = []
      let number = 0
      for await (const line of fileLines(path)) {
        number += 1
        if (line.toLowerCase().includes(lowered)) {
          hits.push({ number, text: line })
          if (hits.length >= limit) {
            break
          }
        }
      }

      return hits
    },
    async readLines(path, from, to) {
      const lines: string[] = []
      let number = 0
      for await (const line of fileLines(path)) {
        number += 1
        if (number > to) {
          break
        }
        if (number >= from) {
          lines.push(line)
        }
      }

      return lines
    },
  }
}
