import { describe, expect, it } from 'vitest'
import {
  formatWorkflowIterationPath,
  groupWorkflowExecutionHistory,
  latestWorkflowNodeExecution,
} from '../../packages/client/src/components/hermes/workflow/history'
import type { WorkflowRunNodeExecutionRecord } from '../../packages/client/src/api/hermes/workflows'

const execution = (
  execution_id: string,
  node_id: string,
  sequence: number,
  iteration_path: WorkflowRunNodeExecutionRecord['iteration_path'],
  session_id: string | null = `session-${execution_id}`,
  status: WorkflowRunNodeExecutionRecord['status'] = 'completed',
): WorkflowRunNodeExecutionRecord => ({
  execution_id, run_id: 'run-1', workflow_id: 'workflow-1', node_id, session_id,
  profile: 'default', agent: 'hermes', agent_mode: '', iteration_path, status,
  reason: status === 'skipped' ? 'join all was not satisfied' : '', sequence,
  started_at: status === 'skipped' ? null : sequence * 10,
  finished_at: sequence * 10 + 5, created_at: sequence, updated_at: sequence,
  error: null,
})

describe('workflow loop history grouping', () => {
  it('groups execution evidence by canonical ordered nested iteration path', () => {
    const outer1 = [{ loopId: 'loop:outer', iteration: 1 }]
    const inner1 = [...outer1, { loopId: 'loop:inner', iteration: 1 }]
    const inner2 = [...outer1, { loopId: 'loop:inner', iteration: 2 }]
    const rows = [
      execution('outer', 'outer-h', 0, outer1),
      execution('inner-1', 'inner-h', 1, inner1),
      execution('skip', 'branch', 2, inner1, null, 'skipped'),
      execution('inner-2', 'inner-h', 3, inner2),
      execution('publish', 'publish', 4, []),
    ]

    expect(groupWorkflowExecutionHistory(rows)).toEqual([
      { key: JSON.stringify(outer1), path: outer1, label: 'loop:outer #1', executions: [rows[0]] },
      { key: JSON.stringify(inner1), path: inner1, label: 'loop:outer #1 › loop:inner #1', executions: [rows[1], rows[2]] },
      { key: JSON.stringify(inner2), path: inner2, label: 'loop:outer #1 › loop:inner #2', executions: [rows[3]] },
      { key: '[]', path: [], label: 'root', executions: [rows[4]] },
    ])
  })

  it('formats paths and picks the latest repeated execution for a node', () => {
    const rows = [
      execution('first', 'review', 2, [{ loopId: 'loop:r', iteration: 1 }]),
      execution('other', 'draft', 3, [{ loopId: 'loop:r', iteration: 2 }]),
      execution('second', 'review', 4, [{ loopId: 'loop:r', iteration: 2 }]),
    ]
    expect(formatWorkflowIterationPath([])).toBe('root')
    expect(formatWorkflowIterationPath(rows[2].iteration_path)).toBe('loop:r #2')
    expect(latestWorkflowNodeExecution(rows, 'review')).toBe(rows[2])
    expect(latestWorkflowNodeExecution(rows, 'missing')).toBeNull()
  })
})
