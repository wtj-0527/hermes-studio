import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('packages/client/src/views/hermes/WorkflowView.vue', 'utf8')

describe('Workflow v2 loop UI', () => {
  it('edits explicit bounded feedback edges with a numeric maximum', () => {
    expect(source).toContain('NInputNumber')
    expect(source).toContain("t('workflow.orchestration.feedbackLoop')")
    expect(source).toContain('v-model:value=\"edgeLoopMaxIterations\"')
    expect(source).toContain(':min=\"1\"')
    expect(source).toContain(':max=\"MAX_WORKFLOW_LOOP_ITERATIONS\"')
    expect(source).toContain('edgeLoopEnabled.value, edgeLoopMaxIterations.value')
  })

  it('renders iteration history and opens the exact execution session clicked', () => {
    expect(source).toContain("t('workflow.runs.iterationHistory')")
    expect(source).toContain('groupWorkflowExecutionHistory')
    expect(source).toContain('@click=\"openWorkflowExecutionSession(execution)\"')
    expect(source).toContain('async function openWorkflowExecutionSession(execution: WorkflowRunNodeExecutionRecord)')
    expect(source).toContain('execution.session_id')
    expect(source).toContain('.workflow-run-v2-history {')
    expect(source).toContain('.workflow-run-v2-execution {')
  })
})
