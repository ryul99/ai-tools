import { correctionInstruction, namesRule, STAGE1_INSTRUCTION, STAGE2_INSTRUCTION } from './policy.ts'

export interface UsageLike {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface ReplyLike {
  role: 'assistant'
  content: Array<{ type: string, text?: string }>
  stopReason: string
  errorMessage?: string
  usage?: UsageLike
}

export interface CompletionRequest {
  systemPrompt: string
  messages: unknown[]
  maxTokens: number
}

export type Complete = (request: CompletionRequest) => Promise<ReplyLike>

export interface Verdict {
  /** `ask` when the review blocked twice without naming a deny rule, so the user decides. */
  decision: 'allow' | 'block' | 'ask' | 'error'
  /** 1 when the fast screen allowed the action, 2 when the careful review decided it. */
  stage: 1 | 2
  rule?: string
  reason: string
  usage: UsageLike[]
}

const STAGE1_MAX_TOKENS = 256
const STAGE2_MAX_TOKENS = 4_096

function replyText(reply: ReplyLike): string {
  return reply.content.flatMap(block => block.type === 'text' && block.text ? [block.text] : []).join('\n').trim()
}

function failure(reply: ReplyLike): string | undefined {
  if (reply.stopReason === 'error' || reply.stopReason === 'aborted') {
    return reply.errorMessage ?? `The review request ended with "${reply.stopReason}".`
  }
  return undefined
}

function lastField(text: string, name: string): string | undefined {
  const matches = [...text.matchAll(new RegExp(`^\\s*\\**${name}\\**\\s*:\\s*(.+?)\\s*$`, 'gim'))]
  return matches.at(-1)?.[1]?.replace(/\*+$/, '').trim()
}

export function parseStage1(text: string): 'allow' | 'block' | undefined {
  const word = text.trim().replace(/^[^A-Za-z]+/, '').split(/[^A-Za-z]/)[0].toUpperCase()
  return word === 'ALLOW' ? 'allow' : word === 'BLOCK' ? 'block' : undefined
}

export function parseStage2(text: string): { decision: 'allow' | 'block', rule?: string, reason: string } | undefined {
  const decision = lastField(text, 'DECISION')?.toLowerCase().replace(/[^a-z]/g, '')
  if (decision !== 'allow' && decision !== 'block') {
    return undefined
  }
  const rule = lastField(text, 'RULE')
  return {
    decision,
    rule: rule === undefined || /^none\.?$/i.test(rule) ? undefined : rule,
    reason: lastField(text, 'REASON') ?? (decision === 'allow' ? 'Allowed.' : 'The reviewer blocked this action.'),
  }
}

/**
 * Two-stage review. The screen asks for one word and leans toward blocking, so most safe actions
 * pass with a tiny response; only flagged actions get a reasoned second look. The second request
 * repeats the first one verbatim and appends to it, so providers with prompt caching reuse the
 * whole first request as a cached prefix.
 *
 * A block must name one of `denyRules`. A block that names none, or names an ALLOW exception, is
 * usually a false positive, so the review is told so once and re-evaluates; if it still names none,
 * the user decides.
 */
export async function classify(complete: Complete, systemPrompt: string, request: string, denyRules: string[]): Promise<Verdict> {
  const usage: UsageLike[] = []
  const firstTurn = {
    role: 'user',
    content: [{ type: 'text', text: request }, { type: 'text', text: STAGE1_INSTRUCTION }],
    timestamp: Date.now(),
  }

  const screen = await complete({ systemPrompt, messages: [firstTurn], maxTokens: STAGE1_MAX_TOKENS })
  if (screen.usage) {
    usage.push(screen.usage)
  }
  const screenError = failure(screen)
  if (screenError) {
    return { decision: 'error', stage: 1, reason: screenError, usage }
  }
  if (parseStage1(replyText(screen)) === 'allow') {
    return { decision: 'allow', stage: 1, reason: 'Allowed by the screen.', usage }
  }

  const secondTurn = { role: 'user', content: [{ type: 'text', text: STAGE2_INSTRUCTION }], timestamp: Date.now() }
  const review = await complete({ systemPrompt, messages: [firstTurn, screen, secondTurn], maxTokens: STAGE2_MAX_TOKENS })
  if (review.usage) {
    usage.push(review.usage)
  }
  const reviewError = failure(review)
  if (reviewError) {
    return { decision: 'error', stage: 2, reason: reviewError, usage }
  }
  const parsed = parseStage2(replyText(review))
  if (!parsed) {
    return { decision: 'error', stage: 2, reason: 'The reviewer did not return a decision.', usage }
  }
  if (parsed.decision === 'allow' || namesRule(parsed.rule, denyRules)) {
    return { ...parsed, stage: 2, usage }
  }

  const correction = { role: 'user', content: [{ type: 'text', text: correctionInstruction(parsed.rule) }], timestamp: Date.now() }
  const second = await complete({ systemPrompt, messages: [firstTurn, screen, secondTurn, review, correction], maxTokens: STAGE2_MAX_TOKENS })
  if (second.usage) {
    usage.push(second.usage)
  }
  const secondError = failure(second)
  if (secondError) {
    return { decision: 'error', stage: 2, reason: secondError, usage }
  }
  const reparsed = parseStage2(replyText(second))
  if (!reparsed) {
    return { decision: 'error', stage: 2, reason: 'The reviewer did not return a decision.', usage }
  }
  if (reparsed.decision === 'allow' || namesRule(reparsed.rule, denyRules)) {
    return { ...reparsed, stage: 2, usage }
  }
  return { ...reparsed, decision: 'ask', stage: 2, usage }
}
