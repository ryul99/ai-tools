// Shared by english-lecturer and english-lecturer-mod (through its `hooks/core` link), so it
// imports nothing: Node runs it in the plugin and the mod engine in the mod.

export type CorrectionCategory = 'grammar' | 'vocabulary' | 'style' | 'spelling' | 'word_order'

export type Correction = {
  original: string
  suggestion: string
  category: CorrectionCategory
  explanation: string
}

export type Lesson = {
  enhancedPrompt: string
  hasCorrections: boolean
  corrections: Correction[]
  tip: string
}

const TARGET_LANGUAGE = 'Korean'
const MAX_CORRECTIONS = 3
const CATEGORIES: readonly CorrectionCategory[] = ['grammar', 'vocabulary', 'style', 'spelling', 'word_order']

const OPENING = `You are a supportive, encouraging English coach for a ${TARGET_LANGUAGE} developer. Analyze the prompt below and`
const ENHANCED_PROMPT =
  'Rewrite to be clear, natural, professional English. Preserve the original intent exactly. If the prompt is code-only or already perfect English, return it unchanged.'
const HAS_CORRECTIONS =
  'true if you made any meaningful improvements, false if the prompt was already correct or is pure code/commands.'
const CORRECTION_FIELDS = [
  '- original: the phrase from the original prompt',
  '- suggestion: the improved phrase',
  `- category: one of ${CATEGORIES.join(', ')}`,
  `- explanation: brief explanation in ${TARGET_LANGUAGE} (1 sentence, max 20 words).`,
]
const TIP = `One memorable tip in ${TARGET_LANGUAGE} (1 sentence, max 30 words) about the most useful pattern. If no corrections, share a useful English expression tip.`
const FOCUS = `Focus on patterns ${TARGET_LANGUAGE} speakers commonly struggle with: articles (a/the), prepositions, singular/plural, tense consistency, word order.`

function indented(lines: readonly string[], indent: string): string {
  return lines.map(line => `${indent}${line}`).join('\n')
}

/** The JSON Schema a CLI's structured output is held to. */
export const LESSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    enhanced_prompt: { type: 'string', description: 'The improved prompt preserving original meaning' },
    has_corrections: { type: 'boolean', description: 'Whether the original prompt had any issues to improve' },
    corrections: {
      type: 'array',
      maxItems: MAX_CORRECTIONS,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          original: { type: 'string' },
          suggestion: { type: 'string' },
          category: { type: 'string', enum: CATEGORIES },
          explanation: { type: 'string' },
        },
        required: ['original', 'suggestion', 'category', 'explanation'],
      },
      description: `Gentle improvement suggestions, max ${MAX_CORRECTIONS} items`,
    },
    tip: { type: 'string', description: 'One concise learning tip' },
  },
  required: ['enhanced_prompt', 'has_corrections', 'corrections', 'tip'],
}

/**
 * The lesson request: `schema` for a CLI that holds the reply to
 * `LESSON_SCHEMA`, `text` for a model that answers in prose and must be told
 * to reply with the object alone.
 */
export function lessonPrompt(prompt: string, format: 'schema' | 'text'): string {
  const fields =
    format === 'schema'
      ? `${OPENING} return structured JSON.

Rules:
1. enhanced_prompt: ${ENHANCED_PROMPT}
2. has_corrections: ${HAS_CORRECTIONS}
3. corrections: List up to ${MAX_CORRECTIONS} gentle improvement suggestions. Each must have:
${indented(CORRECTION_FIELDS, '   ')}
4. tip: ${TIP}`
      : `${OPENING} reply with one JSON object and nothing else: no prose and no code fence.

The object has exactly these fields:
- enhanced_prompt (string): ${ENHANCED_PROMPT}
- has_corrections (boolean): ${HAS_CORRECTIONS}
- corrections (array, at most ${MAX_CORRECTIONS} items): gentle improvement suggestions. Each item has:
${indented(CORRECTION_FIELDS, '  ')}
- tip (string): ${TIP}`

  return `${fields}

${FOCUS}

<PROMPT>
${prompt}
</PROMPT>`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toCorrection(value: unknown): Correction | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const { original, suggestion, category, explanation } = value
  const known = CATEGORIES.find(item => item === category)
  if (typeof original !== 'string' || typeof suggestion !== 'string' || typeof explanation !== 'string' || known === undefined) {
    return undefined
  }

  return { original, suggestion, category: known, explanation }
}

/** A lesson from a reply object, or `undefined` when it is not one. */
export function toLesson(value: unknown): Lesson | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const { enhanced_prompt, has_corrections, corrections, tip } = value
  if (
    typeof enhanced_prompt !== 'string' ||
    typeof has_corrections !== 'boolean' ||
    !Array.isArray(corrections) ||
    typeof tip !== 'string'
  ) {
    return undefined
  }

  return {
    enhancedPrompt: enhanced_prompt,
    hasCorrections: has_corrections,
    corrections: corrections
      .map(toCorrection)
      .filter((item): item is Correction => item !== undefined)
      .slice(0, MAX_CORRECTIONS),
    tip,
  }
}

/** A lesson from a model's prose reply, read from its outermost braces. */
export function parseLesson(reply: string): Lesson | undefined {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start === -1 || end <= start) {
    return undefined
  }
  try {
    return toLesson(JSON.parse(reply.slice(start, end + 1)))
  } catch {
    return undefined
  }
}
