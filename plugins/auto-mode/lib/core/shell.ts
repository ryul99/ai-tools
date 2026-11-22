export interface ParsedCommand {
  /** Words of each simple command, split on `;`, `&&`, `||`, `|`, and newlines. */
  segments: string[][]
  /**
   * True when the command uses constructs whose effect can't be judged from its words:
   * command or process substitution, output redirection to a file, heredocs, background jobs,
   * or unbalanced quoting.
   */
  opaque: boolean
}

const HARMLESS_REDIRECT_TARGETS = new Set(['/dev/null', '&1', '&2'])

export function parseCommand(command: string): ParsedCommand {
  const segments: string[][] = []
  let words: string[] = []
  let word = ''
  let inWord = false
  let quote: '"' | "'" | undefined
  let opaque = false
  let pendingRedirect = false

  const endWord = () => {
    if (!inWord) {
      return
    }
    if (pendingRedirect) {
      if (!HARMLESS_REDIRECT_TARGETS.has(word)) {
        opaque = true
      }
      pendingRedirect = false
    } else {
      words.push(word)
    }
    word = ''
    inWord = false
  }
  const endSegment = () => {
    endWord()
    if (pendingRedirect) {
      opaque = true
      pendingRedirect = false
    }
    if (words.length > 0) {
      segments.push(words)
    }
    words = []
  }

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    const next = command[i + 1]

    if (quote === "'") {
      if (ch === "'") {
        quote = undefined
      } else {
        word += ch
      }
      continue
    }
    if (ch === '\\') {
      if (next === '\n') {
        i++
        continue
      }
      if (next !== undefined) {
        word += next
        inWord = true
        i++
      }
      continue
    }
    if (ch === '`' || (ch === '$' && next === '(')) {
      opaque = true
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = undefined
      } else {
        word += ch
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      inWord = true
      continue
    }
    if (ch === ' ' || ch === '\t') {
      endWord()
      continue
    }
    if (ch === '\n' || ch === ';') {
      endSegment()
      continue
    }
    if (ch === '|' || ch === '&') {
      if (ch === '&' && next === '>') {
        endWord()
        pendingRedirect = true
        i++
        continue
      }
      if (ch === '&' && next !== '&') {
        opaque = true
      }
      if (next === ch) {
        i++
      }
      endSegment()
      continue
    }
    if (ch === '>') {
      const fd = inWord && /^\d$/.test(word) ? word : undefined
      if (fd !== undefined) {
        word = ''
        inWord = false
      } else {
        endWord()
      }
      if (next === '>') {
        i++
      }
      if (command[i + 1] === '&') {
        const target = command.slice(i + 1).match(/^&\d/)
        if (target) {
          i += target[0].length
          continue
        }
      }
      pendingRedirect = true
      continue
    }
    if (ch === '<') {
      if (next === '(' || next === '<') {
        opaque = true
      }
      endWord()
      continue
    }
    if (ch === '(' || ch === ')' || ch === '{' || ch === '}') {
      if (!inWord) {
        opaque = true
      }
    }
    word += ch
    inWord = true
  }
  if (quote !== undefined) {
    opaque = true
  }
  endSegment()

  return { segments, opaque }
}
