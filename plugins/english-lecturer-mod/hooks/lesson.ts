import type { Correction, CorrectionCategory, Lesson } from '../types'

const TARGET_LANGUAGE = 'Korean'
const MAX_CORRECTIONS = 3
const CATEGORIES: readonly CorrectionCategory[] = [
  'grammar',
  'vocabulary',
  'style',
  'spelling',
  'word_order',
]

export function lessonPrompt(prompt: string): string {
  return `You are a supportive, encouraging English coach for a ${TARGET_LANGUAGE} developer. Analyze the prompt below and reply with one JSON object and nothing else: no prose and no code fence.

The object has exactly these fields:
- enhanced_prompt (string): Rewrite to be clear, natural, professional English. Preserve the original intent exactly. If the prompt is code-only or already perfect English, return it unchanged.
- has_corrections (boolean): true if you made any meaningful improvements, false if the prompt was already correct or is pure code/commands.
- corrections (array, at most ${MAX_CORRECTIONS} items): gentle improvement suggestions. Each item has:
  - original: the phrase from the original prompt
  - suggestion: the improved phrase
  - category: one of ${CATEGORIES.join(', ')}
  - explanation: brief explanation in ${TARGET_LANGUAGE} (1 sentence, max 20 words).
- tip (string): One memorable tip in ${TARGET_LANGUAGE} (1 sentence, max 30 words) about the most useful pattern. If no corrections, share a useful English expression tip.

Focus on patterns ${TARGET_LANGUAGE} speakers commonly struggle with: articles (a/the), prepositions, singular/plural, tense consistency, word order.

<PROMPT>
${prompt}
</PROMPT>`
}

function objectIn(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) {
    return undefined
  }
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toCorrection(value: unknown): Correction | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const { original, suggestion, category, explanation } = value
  const isCategory = CATEGORIES.some(known => known === category)
  if (
    typeof original !== 'string' ||
    typeof suggestion !== 'string' ||
    typeof explanation !== 'string' ||
    !isCategory
  ) {
    return undefined
  }

  return { original, suggestion, category: category as CorrectionCategory, explanation }
}

export function parseLesson(reply: string): Lesson | undefined {
  const value = objectIn(reply)
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
