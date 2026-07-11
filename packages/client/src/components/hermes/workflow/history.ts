import type { WorkflowRunNodeExecutionRecord } from '@/api/hermes/workflows'

export interface WorkflowExecutionHistoryGroup {
  key: string
  path: WorkflowRunNodeExecutionRecord['iteration_path']
  label: string
  executions: WorkflowRunNodeExecutionRecord[]
}

export function formatWorkflowIterationPath(path: WorkflowRunNodeExecutionRecord['iteration_path']): string {
  if (path.length === 0) return 'root'
  return path.map(entry => `${entry.loopId} #${entry.iteration}`).join(' › ')
}

export function groupWorkflowExecutionHistory(rows: WorkflowRunNodeExecutionRecord[]): WorkflowExecutionHistoryGroup[] {
  const groups = new Map<string, WorkflowExecutionHistoryGroup>()
  for (const execution of [...rows].sort((left, right) => left.sequence - right.sequence)) {
    const key = JSON.stringify(execution.iteration_path)
    const existing = groups.get(key)
    if (existing) existing.executions.push(execution)
    else groups.set(key, { key, path: execution.iteration_path, label: formatWorkflowIterationPath(execution.iteration_path), executions: [execution] })
  }
  return [...groups.values()]
}

export function latestWorkflowNodeExecution(rows: WorkflowRunNodeExecutionRecord[], nodeId: string): WorkflowRunNodeExecutionRecord | null {
  let latest: WorkflowRunNodeExecutionRecord | null = null
  for (const execution of rows) {
    if (execution.node_id === nodeId && (!latest || execution.sequence > latest.sequence)) latest = execution
  }
  return latest
}
