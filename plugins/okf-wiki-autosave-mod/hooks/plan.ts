export type PlannerContext = {
  root: string | null
  worklog_dir?: string | null
  worklogs?: unknown
  workspace?: unknown
  planner_prompt?: string
  schema?: unknown
}

export type ApplyResult = { logged: string | null }

export type Plan = { material_change: boolean; worklog: unknown }

export function forkPrompt(context: PlannerContext): string {
  const data = JSON.stringify({ workspace: context.workspace, worklogs: context.worklogs })

  return `This message comes from the okf-wiki-autosave-mod plugin, not from the user. Set the task above aside and answer only as the journaling planner described below.

${context.planner_prompt ?? ''}
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
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }
  const plan = value as Record<string, unknown>
  if (typeof plan.material_change !== 'boolean' || !('worklog' in plan)) {
    return undefined
  }

  return { material_change: plan.material_change, worklog: plan.worklog }
}
