export const CONSECUTIVE_LIMIT = 3
export const TOTAL_LIMIT = 20
const BLOCKED_HISTORY = 20

/**
 * Counts classifier blocks. Too many in a row or in total means the classifier and the agent
 * disagree about the task, so review pauses and the user decides until they approve an action.
 */
export class DenialTracker {
  consecutive = 0
  total = 0
  paused: 'consecutive' | 'total' | undefined

  allowed(): void {
    this.consecutive = 0
  }

  blocked(): void {
    this.consecutive++
    this.total++
    if (this.total >= TOTAL_LIMIT) {
      this.paused = 'total'
    } else if (this.consecutive >= CONSECUTIVE_LIMIT) {
      this.paused ??= 'consecutive'
    }
  }

  userApproved(): void {
    if (this.paused === 'total') {
      this.total = 0
    }
    this.consecutive = 0
    this.paused = undefined
  }
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stable)
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]))
  }
  return value
}

export function actionKey(toolName: string, input: unknown): string {
  return `${toolName}\u0000${JSON.stringify(stable(input))}`
}

export interface BlockedAction {
  key: string
  toolName: string
  input: unknown
  rule?: string
  reason: string
}

export class BlockedActions {
  private items: BlockedAction[] = []
  private approved = new Set<string>()

  add(action: BlockedAction): void {
    this.items = [action, ...this.items.filter(item => item.key !== action.key)].slice(0, BLOCKED_HISTORY)
  }

  list(): readonly BlockedAction[] {
    return this.items
  }

  approve(key: string): void {
    this.approved.add(key)
    this.items = this.items.filter(item => item.key !== key)
  }

  /** True once for an approved action, then the approval is spent. */
  consumeApproval(key: string): boolean {
    return this.approved.delete(key)
  }
}
