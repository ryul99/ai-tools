import { isRecord } from './core/text.ts'
import type { PlannerContext } from './core/worklog.ts'

export type ReadyContext = Extract<PlannerContext, { worklog_dir: string }>

export type Plan = { worklog: unknown }

export function forkPrompt(context: ReadyContext): string {
  const data = JSON.stringify({ workspace: context.workspace, worklogs: context.worklogs })

  return `This message comes from the okf-wiki-autosave-mod plugin, not from the user. Set the task above aside and answer only as the journaling planner described below.

${context.planner_prompt}
Reply with one JSON object and nothing else: no prose and no code fence. The object must match this JSON Schema:
${JSON.stringify(context.schema)}

<context>
${data}
</context>`
}

export function parsePlan(reply: string): Plan | undefined {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start === -1 || end <= start) {
    return undefined
  }
  let value: unknown
  try {
    value = JSON.parse(reply.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (!isRecord(value) || !('worklog' in value)) {
    return undefined
  }

  return { worklog: value.worklog }
}
