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

export type LessonView =
  | { ticket: number; status: 'pending' }
  | { ticket: number; status: 'ready'; lesson: Lesson }
  | { ticket: number; status: 'failed'; reason: string }

declare module 'claude-code' {
  interface PluginState {
    'english-lecturer-mod': { lesson: LessonView | null }
  }
}
