import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const state = vi.hoisted(() => ({
  db: null as DatabaseSync | null,
  appHome: '',
  runAndWait: vi.fn(),
  abortSession: vi.fn(),
  deleteSession: vi.fn(),
  deleteUsage: vi.fn(),
  getSession: vi.fn(),
}))

vi.mock('../../packages/server/src/db/index', () => ({
  getDb: () => state.db,
  jsonDelete: vi.fn(), jsonGet: vi.fn(), jsonGetAll: vi.fn(() => ({})), jsonSet: vi.fn(),
  getStoragePath: () => ':memory:',
}))
vi.mock('../../packages/server/src/config', () => ({ config: { appHome: state.appHome } }))
vi.mock('../../packages/server/src/routes/hermes/chat-run', () => ({
  getChatRunServer: () => ({ runAndWait: state.runAndWait, abortSession: state.abortSession }),
}))
vi.mock('../../packages/server/src/db/hermes/sessions-db', () => ({ getExactSessionDetailFromDbWithProfile: vi.fn() }))
vi.mock('../../packages/server/src/db/hermes/session-store', () => ({
  deleteSession: state.deleteSession, getSession: state.getSession, getSessionDetail: vi.fn(() => null),
}))
vi.mock('../../packages/server/src/db/hermes/usage-store', () => ({ deleteUsage: state.deleteUsage }))
vi.mock('../../packages/server/src/services/workflow-skill-resolver', () => ({ resolveWorkflowSkillContent: vi.fn() }))
vi.mock('../../packages/server/src/services/agent-runner/coding-agent-run-manager', () => ({ codingAgentRunManager: { stop: vi.fn(), hasSession: vi.fn(() => false) } }))
vi.mock('../../packages/server/src/services/hermes/hermes-cli', () => ({ deleteSessionForProfile: vi.fn() }))
vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({ listProfileNamesFromDisk: vi.fn(() => []) }))
vi.mock('../../packages/server/src/services/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
vi.mock('../../packages/server/src/controllers/hermes/models', () => ({
  getAvailableModelReferencesForProfile: vi.fn(async () => [
    { provider: 'custom:test', model: 'gpt-test', apiMode: 'chat_completions' },
  ]),
  getEffectiveModelReferenceForProfile: vi.fn(async () => (
    { provider: 'custom:test', model: 'gpt-test', apiMode: 'chat_completions' }
  )),
}))

const node = (id: string) => ({ id, type: 'agent', data: { title: id, agent: 'hermes', input: id } })
const edge = (id: string, source: string, target: string, orchestration?: Record<string, unknown>) => ({
  id, source, target, ...(orchestration ? { data: { orchestration } } : {}),
})
const feedback = (id: string, source: string, target: string, maxIterations: number) => edge(id, source, target, {
  route: 'success', condition: { path: 'json.retry', operator: 'truthy' }, loop: { maxIterations },
})

function currentTask(request: any): string {
  const text = typeof request.input === 'string' ? request.input : request.input[0].text
  return String(text).split('[Current task]\n').at(-1) || ''
}

describe('workflow v2 loop runtime', () => {
  let root: string
  beforeEach(async () => {
    vi.resetModules()
    state.runAndWait.mockReset()
    state.abortSession.mockReset().mockResolvedValue(undefined)
    state.deleteSession.mockReset()
    state.deleteUsage.mockReset()
    state.getSession.mockReset().mockImplementation((id: string) => ({ id, source: 'workflow', agent: 'hermes', profile: 'default' }))
    root = mkdtempSync(join(tmpdir(), 'workflow-loop-runtime-'))
    state.appHome = join(root, 'home')
    state.db = new DatabaseSync(join(root, 'workflow.db'))
    const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')
    initAllHermesTables()
  })
  afterEach(() => {
    state.db?.close(); state.db = null
    rmSync(root, { recursive: true, force: true })
  })

  it('repeats with fresh sessions, suppresses retry-epoch exits, and releases only the final exit', async () => {
    let reviewCount = 0
    const requests: any[] = []
    state.runAndWait.mockImplementation(async (request: any) => {
      requests.push(request)
      const task = currentTask(request)
      if (task === 'review') {
        reviewCount += 1
        return { ok: true, output: JSON.stringify({ retry: reviewCount === 1, reviewCount }) }
      }
      return { ok: true, output: task }
    })
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const {
      listWorkflowRunEdgeEvaluations,
      listWorkflowRunLoopIterations,
      listWorkflowRunNodeExecutions,
    } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const workflow = createWorkflow({
      name: 'retry with barrier',
      nodes: [node('draft'), node('review'), node('publish')],
      edges: [
        edge('draft-review', 'draft', 'review'),
        feedback('review-retry', 'review', 'draft', 3),
        edge('review-publish', 'review', 'publish'),
      ],
    })

    const result = await new WorkflowManager().runNow(workflow.id)
    const executions = listWorkflowRunNodeExecutions(result.run.id)
    const evaluations = listWorkflowRunEdgeEvaluations(result.run.id)
    const iterations = listWorkflowRunLoopIterations(result.run.id)

    expect(result.run).toMatchObject({ status: 'completed', orchestration_version: 2, execution_count: 5, terminal_code: null })
    expect(requests.map(currentTask)).toEqual(['draft', 'review', 'draft', 'review', 'publish'])
    expect(new Set(requests.map(request => request.session_id)).size).toBe(5)
    expect(executions.map(item => ({ node: item.node_id, path: item.iteration_path, status: item.status }))).toEqual([
      { node: 'draft', path: [{ loopId: 'loop:review-retry', iteration: 1 }], status: 'completed' },
      { node: 'review', path: [{ loopId: 'loop:review-retry', iteration: 1 }], status: 'completed' },
      { node: 'draft', path: [{ loopId: 'loop:review-retry', iteration: 2 }], status: 'completed' },
      { node: 'review', path: [{ loopId: 'loop:review-retry', iteration: 2 }], status: 'completed' },
      { node: 'publish', path: [], status: 'completed' },
    ])
    expect(evaluations.filter(item => item.edge_id === 'review-publish').map(item => item.delivery_status)).toEqual(['suppressed', 'delivered'])
    expect(evaluations.filter(item => item.edge_id === 'review-retry').map(item => item.status)).toEqual(['taken', 'not_taken'])
    expect(iterations.map(item => ({ iteration: item.iteration, path: item.iteration_path, status: item.status }))).toEqual([
      { iteration: 1, path: [{ loopId: 'loop:review-retry', iteration: 1 }], status: 'retrying' },
      { iteration: 2, path: [{ loopId: 'loop:review-retry', iteration: 2 }], status: 'completed' },
    ])
    expect(String(requests[2].input)).toContain('"reviewCount":1')
    expect(String(requests[4].input)).toContain('"reviewCount":2')
  })

  it('resets a nested child loop to iteration one when its parent advances', async () => {
    let outerPass = 1
    const innerAttempts = new Map<number, number>()
    const requests: any[] = []
    state.runAndWait.mockImplementation(async (request: any) => {
      requests.push(request)
      const task = currentTask(request)
      if (task === 'inner-l') {
        const attempt = (innerAttempts.get(outerPass) || 0) + 1
        innerAttempts.set(outerPass, attempt)
        return { ok: true, output: JSON.stringify({ retry: attempt === 1, outerPass, attempt }) }
      }
      if (task === 'outer-l') {
        const retry = outerPass === 1
        const output = JSON.stringify({ retry, outerPass })
        if (retry) outerPass += 1
        return { ok: true, output }
      }
      return { ok: true, output: `${task}:${outerPass}` }
    })
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const { listWorkflowRunLoopIterations, listWorkflowRunNodeExecutions } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const workflow = createWorkflow({
      name: 'nested reset',
      nodes: [node('outer-h'), node('inner-h'), node('inner-l'), node('outer-l'), node('publish')],
      edges: [
        edge('outer-enter-inner', 'outer-h', 'inner-h'),
        edge('inner-forward', 'inner-h', 'inner-l'),
        feedback('inner-retry', 'inner-l', 'inner-h', 3),
        edge('inner-exit', 'inner-l', 'outer-l'),
        feedback('outer-retry', 'outer-l', 'outer-h', 2),
        edge('outer-exit', 'outer-l', 'publish'),
      ],
    })

    const result = await new WorkflowManager().runNow(workflow.id)
    const executions = listWorkflowRunNodeExecutions(result.run.id)
    const loops = listWorkflowRunLoopIterations(result.run.id)

    expect(result.run).toMatchObject({ status: 'completed', execution_count: 13 })
    expect(requests.map(currentTask)).toEqual([
      'outer-h', 'inner-h', 'inner-l', 'inner-h', 'inner-l', 'outer-l',
      'outer-h', 'inner-h', 'inner-l', 'inner-h', 'inner-l', 'outer-l', 'publish',
    ])
    expect(executions.filter(item => item.node_id === 'inner-h').map(item => item.iteration_path)).toEqual([
      [{ loopId: 'loop:outer-retry', iteration: 1 }, { loopId: 'loop:inner-retry', iteration: 1 }],
      [{ loopId: 'loop:outer-retry', iteration: 1 }, { loopId: 'loop:inner-retry', iteration: 2 }],
      [{ loopId: 'loop:outer-retry', iteration: 2 }, { loopId: 'loop:inner-retry', iteration: 1 }],
      [{ loopId: 'loop:outer-retry', iteration: 2 }, { loopId: 'loop:inner-retry', iteration: 2 }],
    ])
    expect(loops.filter(item => item.loop_id === 'loop:inner-retry').map(item => ({ path: item.iteration_path, status: item.status }))).toEqual([
      { path: [{ loopId: 'loop:outer-retry', iteration: 1 }, { loopId: 'loop:inner-retry', iteration: 1 }], status: 'retrying' },
      { path: [{ loopId: 'loop:outer-retry', iteration: 1 }, { loopId: 'loop:inner-retry', iteration: 2 }], status: 'completed' },
      { path: [{ loopId: 'loop:outer-retry', iteration: 2 }, { loopId: 'loop:inner-retry', iteration: 1 }], status: 'retrying' },
      { path: [{ loopId: 'loop:outer-retry', iteration: 2 }, { loopId: 'loop:inner-retry', iteration: 2 }], status: 'completed' },
    ])
  })

  it('fails explicitly at maxIterations without dispatching an extra iteration', async () => {
    const requests: any[] = []
    state.runAndWait.mockImplementation(async (request: any) => {
      requests.push(request)
      return { ok: true, output: currentTask(request) === 'review' ? '{"retry":true}' : 'draft output' }
    })
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const { listWorkflowRunEdgeEvaluations, listWorkflowRunLoopIterations, listWorkflowRunNodeExecutions } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const workflow = createWorkflow({
      name: 'loop limit', nodes: [node('draft'), node('review'), node('publish')],
      edges: [edge('forward', 'draft', 'review'), feedback('retry', 'review', 'draft', 2), edge('exit', 'review', 'publish')],
    })

    const result = await new WorkflowManager().runNow(workflow.id)

    expect(result.run).toMatchObject({
      status: 'failed', terminal_code: 'loop_limit_exceeded', execution_count: 4,
      error: expect.stringContaining('maxIterations=2'),
    })
    expect(requests.map(currentTask)).toEqual(['draft', 'review', 'draft', 'review'])
    expect(listWorkflowRunNodeExecutions(result.run.id)).toHaveLength(4)
    expect(listWorkflowRunEdgeEvaluations(result.run.id).filter(item => item.edge_id === 'exit').map(item => item.delivery_status)).toEqual(['suppressed', 'suppressed'])
    expect(listWorkflowRunLoopIterations(result.run.id).map(item => item.status)).toEqual(['retrying', 'failed'])
  })

  it('fails closed on malformed feedback output and releases no exit', async () => {
    state.runAndWait.mockImplementation(async (request: any) => ({
      ok: true, output: currentTask(request) === 'review' ? 'not-json' : 'draft output',
    }))
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const { listWorkflowRunEdgeEvaluations, listWorkflowRunNodeExecutions } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const workflow = createWorkflow({
      name: 'condition error', nodes: [node('draft'), node('review'), node('publish')],
      edges: [edge('forward', 'draft', 'review'), feedback('retry', 'review', 'draft', 3), edge('exit', 'review', 'publish')],
    })

    const result = await new WorkflowManager().runNow(workflow.id)

    expect(result.run).toMatchObject({ status: 'failed', terminal_code: 'loop_condition_error', execution_count: 2 })
    expect(listWorkflowRunNodeExecutions(result.run.id).map(item => item.node_id)).toEqual(['draft', 'review'])
    expect(listWorkflowRunEdgeEvaluations(result.run.id).find(item => item.edge_id === 'retry')).toMatchObject({ status: 'error', delivery_status: 'suppressed' })
    expect(listWorkflowRunEdgeEvaluations(result.run.id).find(item => item.edge_id === 'exit')).toMatchObject({ delivery_status: 'suppressed' })
  })

  it('enforces the global execution budget before creating another session', async () => {
    const requests: any[] = []
    state.runAndWait.mockImplementation(async (request: any) => {
      requests.push(request)
      return { ok: true, output: currentTask(request) === 'review' ? '{"retry":true}' : 'draft output' }
    })
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const { listWorkflowRunNodeExecutions } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const workflow = createWorkflow({
      name: 'budget', nodes: [node('draft'), node('review')],
      edges: [edge('forward', 'draft', 'review'), feedback('retry', 'review', 'draft', 3)],
    })

    const result = await new WorkflowManager().runNow(workflow.id, { executionBudget: 2 })

    expect(result.run).toMatchObject({
      status: 'failed', terminal_code: 'node_execution_budget_exceeded', execution_budget: 2, execution_count: 2,
    })
    expect(requests.map(currentTask)).toEqual(['draft', 'review'])
    expect(listWorkflowRunNodeExecutions(result.run.id)).toHaveLength(2)
  })


  it('stops and drains an active v2 execution through its owning chat runtime', async () => {
    let release!: (value: any) => void
    state.runAndWait.mockImplementation(() => new Promise(resolve => { release = resolve }))
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const { listWorkflowRunLoopIterations, listWorkflowRunNodeExecutions } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const workflow = createWorkflow({
      name: 'cancel active loop', nodes: [node('draft'), node('review')],
      edges: [edge('forward', 'draft', 'review'), feedback('retry', 'review', 'draft', 3)],
    })
    const manager = new WorkflowManager()
    const pending = manager.runNow(workflow.id)
    while (!manager.getRuntimeStatus(workflow.id).runId || state.runAndWait.mock.calls.length < 1) {
      await new Promise(resolve => setTimeout(resolve, 2))
    }
    const runId = manager.getRuntimeStatus(workflow.id).runId!

    const stopPromise = manager.stopRun(workflow.id, runId, 'operator canceled')
    while (state.abortSession.mock.calls.length < 1) await new Promise(resolve => setTimeout(resolve, 2))
    expect(state.abortSession).toHaveBeenCalledWith(expect.any(String), 'operator canceled')
    release({ ok: false, error: 'operator canceled' })
    await stopPromise
    const result = await pending

    expect(result.run).toMatchObject({ status: 'canceled', terminal_code: 'workflow_canceled' })
    expect(listWorkflowRunNodeExecutions(runId)).toEqual([
      expect.objectContaining({ node_id: 'draft', status: 'canceled', error: 'operator canceled' }),
    ])
    expect(listWorkflowRunLoopIterations(runId)).toEqual([
      expect.objectContaining({ loop_id: 'loop:retry', status: 'canceled' }),
    ])
    expect(state.runAndWait).toHaveBeenCalledTimes(1)
  })

  it('enforces a total deadline by aborting active work and dispatching no later iteration', async () => {
    let release!: (value: any) => void
    state.runAndWait.mockImplementation(() => new Promise(resolve => { release = resolve }))
    state.abortSession.mockImplementation(async () => { release({ ok: false, error: 'deadline abort' }) })
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const { listWorkflowRunLoopIterations, listWorkflowRunNodeExecutions } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const workflow = createWorkflow({
      name: 'deadline active loop', nodes: [node('draft'), node('review')],
      edges: [edge('forward', 'draft', 'review'), feedback('retry', 'review', 'draft', 3)],
    })

    const result = await new WorkflowManager().runNow(workflow.id, { totalTimeoutMs: 20 })

    expect(result.run).toMatchObject({
      status: 'failed', terminal_code: 'workflow_timeout', error: expect.stringContaining('total timeout'),
    })
    expect(state.abortSession).toHaveBeenCalledTimes(1)
    expect(state.runAndWait).toHaveBeenCalledTimes(1)
    expect(listWorkflowRunNodeExecutions(result.run.id)).toEqual([
      expect.objectContaining({ node_id: 'draft', status: 'failed', error: expect.stringContaining('total timeout') }),
    ])
    expect(listWorkflowRunLoopIterations(result.run.id)).toEqual([
      expect.objectContaining({ loop_id: 'loop:retry', status: 'failed' }),
    ])
  })


  it('preserves completed retrying history when canceling a later active iteration', async () => {
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const { createWorkflowLoopIteration, createWorkflowRun, listWorkflowRunLoopIterations } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const workflow = createWorkflow({ name: 'cancel history', nodes: [node('draft')], edges: [feedback('self', 'draft', 'draft', 3)] })
    const run = createWorkflowRun({ workflow_id: workflow.id, status: 'running', orchestration_version: 2, snapshot_nodes: workflow.nodes, snapshot_edges: workflow.edges })
    const historical = createWorkflowLoopIteration({ run_id: run.id, workflow_id: workflow.id, loop_id: 'loop:self', iteration_path: [{ loopId: 'loop:self', iteration: 1 }], iteration: 1, status: 'retrying' })
    const active = createWorkflowLoopIteration({ run_id: run.id, workflow_id: workflow.id, loop_id: 'loop:self', iteration_path: [{ loopId: 'loop:self', iteration: 2 }], iteration: 2, status: 'running' })

    await new WorkflowManager().stopRun(workflow.id, run.id, 'operator canceled')

    expect(listWorkflowRunLoopIterations(run.id)).toEqual([
      expect.objectContaining({ id: historical.id, status: 'retrying', error: null }),
      expect.objectContaining({ id: active.id, status: 'canceled', error: 'operator canceled' }),
    ])
  })


  it('deletes every repeated execution session artifact before deleting v2 evidence', async () => {
    let reviewCount = 0
    state.runAndWait.mockImplementation(async (request: any) => {
      const task = currentTask(request)
      if (task === 'review') {
        reviewCount += 1
        return { ok: true, output: JSON.stringify({ retry: reviewCount === 1 }) }
      }
      return { ok: true, output: task }
    })
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const {
      getWorkflowRun, listWorkflowRunEdgeEvaluations, listWorkflowRunLoopIterations, listWorkflowRunNodeExecutions,
    } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const workflow = createWorkflow({
      name: 'delete loop artifacts', nodes: [node('draft'), node('review'), node('publish')],
      edges: [edge('forward', 'draft', 'review'), feedback('retry', 'review', 'draft', 3), edge('exit', 'review', 'publish')],
    })
    const manager = new WorkflowManager()
    const result = await manager.runNow(workflow.id)
    const sessionIds = listWorkflowRunNodeExecutions(result.run.id).map(item => item.session_id!)
    expect(sessionIds).toHaveLength(5)

    await expect(manager.deleteRun(workflow.id, result.run.id)).resolves.toBe(true)

    expect(state.deleteSession.mock.calls.map(call => call[0]).sort()).toEqual([...sessionIds].sort())
    expect(state.deleteUsage.mock.calls.map(call => call[0]).sort()).toEqual([...sessionIds].sort())
    expect(getWorkflowRun(result.run.id)).toBeNull()
    expect(listWorkflowRunNodeExecutions(result.run.id)).toEqual([])
    expect(listWorkflowRunEdgeEvaluations(result.run.id)).toEqual([])
    expect(listWorkflowRunLoopIterations(result.run.id)).toEqual([])
  })


  it('fails orphaned active v2 runs closed after restart and aborts surviving sessions', async () => {
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const {
      createWorkflowLoopIteration, createWorkflowRun, getWorkflowRun, listWorkflowRunLoopIterations,
      listWorkflowRunNodeExecutions, reserveWorkflowNodeExecution, updateWorkflowRunNodeExecution,
    } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const workflow = createWorkflow({
      name: 'orphan recovery', nodes: [node('draft')],
      edges: [feedback('self', 'draft', 'draft', 3)],
    })
    const run = createWorkflowRun({
      workflow_id: workflow.id, status: 'running', orchestration_version: 2,
      snapshot_nodes: workflow.nodes, snapshot_edges: workflow.edges,
      compiler_version: 'workflow-orchestration-v2', compiled_plan: { loops: [{ id: 'loop:self' }] },
      deadline_at: Date.now() + 60_000, execution_budget: 10, started_at: Date.now() - 1_000,
    })
    const reservation = reserveWorkflowNodeExecution({
      run_id: run.id, workflow_id: workflow.id, node_id: 'draft', session_id: 'orphan-session',
      profile: 'default', agent: 'hermes', agent_mode: '', iteration_path: [{ loopId: 'loop:self', iteration: 1 }],
    })
    if (!reservation.ok) throw new Error('unexpected budget failure')
    updateWorkflowRunNodeExecution(reservation.execution.execution_id, { status: 'running', started_at: Date.now() - 900 })
    const historical = createWorkflowLoopIteration({
      run_id: run.id, workflow_id: workflow.id, loop_id: 'loop:self',
      iteration_path: [{ loopId: 'loop:self', iteration: 1 }], iteration: 1, status: 'retrying',
    })
    const active = createWorkflowLoopIteration({
      run_id: run.id, workflow_id: workflow.id, loop_id: 'loop:self',
      iteration_path: [{ loopId: 'loop:self', iteration: 2 }], iteration: 2, status: 'running',
    })

    const recovered = await new WorkflowManager().recoverOrphanedV2Runs()

    expect(recovered).toEqual({ runs: 1, sessions: 1 })
    expect(state.abortSession).toHaveBeenCalledWith('orphan-session', expect.stringContaining('server restarted'))
    expect(getWorkflowRun(run.id)).toMatchObject({
      status: 'failed', terminal_code: 'runtime_restarted', error: expect.stringContaining('server restarted'),
    })
    expect(listWorkflowRunNodeExecutions(run.id)).toEqual([
      expect.objectContaining({ status: 'failed', error: expect.stringContaining('server restarted') }),
    ])
    expect(listWorkflowRunLoopIterations(run.id)).toEqual([
      expect.objectContaining({ id: historical.id, status: 'retrying', error: null }),
      expect.objectContaining({ id: active.id, status: 'failed', error: expect.stringContaining('server restarted') }),
    ])
    await expect(new WorkflowManager().recoverOrphanedV2Runs()).resolves.toEqual({ runs: 0, sessions: 0 })
  })


  it('keeps join:all inputs isolated to the current loop iteration', async () => {
    let pass = 0
    const reviewInputs: string[] = []
    const requests: any[] = []
    state.runAndWait.mockImplementation(async (request: any) => {
      requests.push(request)
      const task = currentTask(request)
      if (task === 'header') {
        pass += 1
        return { ok: true, output: `header-${pass}` }
      }
      if (task === 'left' || task === 'right') return { ok: true, output: `${task}-${pass}` }
      if (task === 'review') {
        reviewInputs.push(String(request.input))
        return { ok: true, output: JSON.stringify({ retry: pass === 1, pass }) }
      }
      return { ok: true, output: task }
    })
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const { listWorkflowRunNodeExecutions } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const review = node('review')
    review.data = { ...review.data, orchestration: { joinMode: 'all' } } as any
    const workflow = createWorkflow({
      name: 'join all iteration isolation',
      nodes: [node('header'), node('left'), node('right'), review, node('publish')],
      edges: [
        edge('header-left', 'header', 'left'), edge('header-right', 'header', 'right'),
        edge('left-review', 'left', 'review'), edge('right-review', 'right', 'review'),
        feedback('review-retry', 'review', 'header', 2), edge('review-publish', 'review', 'publish'),
      ],
    })

    const result = await new WorkflowManager().runNow(workflow.id)

    expect(result.run).toMatchObject({ status: 'completed', execution_count: 9 })
    expect(reviewInputs).toHaveLength(2)
    expect(reviewInputs[0]).toContain('left-1')
    expect(reviewInputs[0]).toContain('right-1')
    expect(reviewInputs[1]).toContain('left-2')
    expect(reviewInputs[1]).toContain('right-2')
    expect(reviewInputs[1]).not.toContain('left-1')
    expect(reviewInputs[1]).not.toContain('right-1')
    expect(String(requests.at(-1)?.input)).toContain('"pass":2')
    expect(listWorkflowRunNodeExecutions(result.run.id).filter(item => item.node_id === 'review').map(item => item.iteration_path)).toEqual([
      [{ loopId: 'loop:review-retry', iteration: 1 }],
      [{ loopId: 'loop:review-retry', iteration: 2 }],
    ])
  })


  it('starts join:any from the first taken edge without waiting for slower siblings', async () => {
    let releaseSlow!: (value: any) => void
    let mergeStartedBeforeSlowFinished = false
    let slowFinished = false
    const mergeInputs: string[] = []
    state.runAndWait.mockImplementation(async (request: any) => {
      const task = currentTask(request)
      if (task === 'header') return { ok: true, output: 'header-output' }
      if (task === 'fast') return { ok: true, output: 'fast-output' }
      if (task === 'slow') {
        const result = await new Promise(resolve => { releaseSlow = resolve })
        slowFinished = true
        return result
      }
      if (task === 'merge') {
        mergeStartedBeforeSlowFinished = !slowFinished
        mergeInputs.push(String(request.input))
        releaseSlow({ ok: true, output: 'slow-output' })
        return { ok: true, output: JSON.stringify({ retry: false }) }
      }
      return { ok: true, output: task }
    })
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const { listWorkflowRunEdgeEvaluations, listWorkflowRunNodeExecutions } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const merge = node('merge')
    merge.data = { ...merge.data, orchestration: { joinMode: 'any' } } as any
    const workflow = createWorkflow({
      name: 'join any first taken',
      nodes: [node('header'), node('fast'), node('slow'), merge, node('publish')],
      edges: [
        edge('header-fast', 'header', 'fast'), edge('header-slow', 'header', 'slow'),
        edge('fast-merge', 'fast', 'merge'), edge('slow-merge', 'slow', 'merge'),
        feedback('merge-retry', 'merge', 'header', 2), edge('merge-publish', 'merge', 'publish'),
      ],
    })

    const result = await new WorkflowManager().runNow(workflow.id)

    expect(result.run).toMatchObject({ status: 'completed', execution_count: 5 })
    expect(mergeStartedBeforeSlowFinished).toBe(true)
    expect(mergeInputs).toHaveLength(1)
    expect(mergeInputs[0]).toContain('fast-output')
    expect(mergeInputs[0]).not.toContain('slow-output')
    const mergeExecution = listWorkflowRunNodeExecutions(result.run.id).find(item => item.node_id === 'merge')!
    const evaluations = listWorkflowRunEdgeEvaluations(result.run.id)
    expect(evaluations.find(item => item.edge_id === 'fast-merge')?.consumed_by_execution_id).toBe(mergeExecution.execution_id)
    expect(evaluations.find(item => item.edge_id === 'slow-merge')?.consumed_by_execution_id).toBeNull()
  })


  it('assembles join:all inputs in graph edge order instead of completion order', async () => {
    let releaseLeft!: (value: any) => void
    const reviewInputs: string[] = []
    state.runAndWait.mockImplementation(async (request: any) => {
      const task = currentTask(request)
      if (task === 'root') return { ok: true, output: 'root' }
      if (task === 'left') return await new Promise(resolve => { releaseLeft = resolve })
      if (task === 'right') { setTimeout(() => releaseLeft({ ok: true, output: 'left-output' }), 10); return { ok: true, output: 'right-output' } }
      if (task === 'review') reviewInputs.push(String(request.input))
      if (task === 'latch') return { ok: true, output: '{"retry":false}' }
      return { ok: true, output: task }
    })
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const review = node('review')
    review.data = { ...review.data, orchestration: { joinMode: 'all' } } as any
    const workflow = createWorkflow({
      name: 'deterministic join input order',
      nodes: [node('root'), node('left'), node('right'), review, node('latch')],
      edges: [
        edge('root-left', 'root', 'left'), edge('root-right', 'root', 'right'),
        edge('left-review', 'left', 'review'), edge('right-review', 'right', 'review'),
        edge('review-latch', 'review', 'latch'), feedback('retry', 'latch', 'root', 1),
      ],
    })

    const result = await new WorkflowManager().runNow(workflow.id)

    expect(result.run.status).toBe('completed')
    expect(reviewInputs).toHaveLength(1)
    expect(reviewInputs[0].indexOf('left-output')).toBeLessThan(reviewInputs[0].indexOf('right-output'))
  })


  it('revalidates an outer settlement candidate after an inner retry creates new child work', async () => {
    let innerHeadCount = 0
    let innerLatchCount = 0
    let releaseSecondInnerHead!: (value: any) => void
    let secondInnerHeadStarted = false
    let publishStarted = false
    state.runAndWait.mockImplementation(async (request: any) => {
      const task = currentTask(request)
      if (task === 'outer-h') return { ok: true, output: 'outer-head' }
      if (task === 'outer-l') return { ok: true, output: '{"retry":false}' }
      if (task === 'inner-h') {
        innerHeadCount += 1
        if (innerHeadCount === 2) {
          secondInnerHeadStarted = true
          return await new Promise(resolve => { releaseSecondInnerHead = resolve })
        }
        return { ok: true, output: 'inner-head-1' }
      }
      if (task === 'inner-l') {
        innerLatchCount += 1
        return { ok: true, output: JSON.stringify({ retry: innerLatchCount === 1 }) }
      }
      if (task === 'publish') publishStarted = true
      return { ok: true, output: task }
    })
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const outerLatch = node('outer-l')
    outerLatch.data = { ...outerLatch.data, orchestration: { joinMode: 'any' } } as any
    const workflow = createWorkflow({
      name: 'nested stale parent candidate',
      nodes: [node('outer-h'), node('inner-h'), node('inner-l'), outerLatch, node('publish')],
      edges: [
        edge('outer-fast-latch', 'outer-h', 'outer-l'), edge('outer-enter-inner', 'outer-h', 'inner-h'),
        edge('inner-forward', 'inner-h', 'inner-l'), feedback('inner-retry', 'inner-l', 'inner-h', 2),
        edge('inner-to-outer-latch', 'inner-l', 'outer-l'), feedback('outer-retry', 'outer-l', 'outer-h', 1),
        edge('outer-exit', 'outer-l', 'publish'),
      ],
    })

    const pending = new WorkflowManager().runNow(workflow.id)
    while (!secondInnerHeadStarted) await new Promise(resolve => setTimeout(resolve, 2))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(publishStarted).toBe(false)
    releaseSecondInnerHead({ ok: true, output: 'inner-head-2' })
    const result = await pending
    expect(result.run.status).toBe('completed')
    expect(publishStarted).toBe(true)
  })


  it('recovers an orphaned v2 run even when 500 newer runs exist', async () => {
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const { createWorkflowRun, getWorkflowRun } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const workflow = createWorkflow({ name: 'orphan beyond history page', nodes: [node('only')], edges: [] })
    const orphan = createWorkflowRun({
      workflow_id: workflow.id, profile: 'default', workspace: '', start_node_ids: ['only'],
      status: 'running', snapshot_nodes: [node('only')], snapshot_edges: [],
      orchestration_version: 2, compiler_version: 'test', compiled_plan: {}, execution_budget: 1,
    })
    for (let index = 0; index < 500; index += 1) {
      createWorkflowRun({
        workflow_id: workflow.id, profile: 'default', workspace: '', start_node_ids: ['only'],
        status: 'completed', snapshot_nodes: [node('only')], snapshot_edges: [],
        orchestration_version: 2, compiler_version: 'test', compiled_plan: {}, execution_budget: 1,
      })
    }

    await expect(new WorkflowManager().recoverOrphanedV2Runs()).resolves.toMatchObject({ runs: 1 })
    expect(getWorkflowRun(orphan.id)).toMatchObject({ status: 'failed', terminal_code: 'runtime_restarted' })
  })

  it('deletes every run when a workflow has more than 500 historical runs', async () => {
    const { createWorkflow, getWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const { createWorkflowRun } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const workflow = createWorkflow({ name: 'delete beyond history page', nodes: [node('only')], edges: [] })
    for (let index = 0; index < 501; index += 1) {
      createWorkflowRun({
        workflow_id: workflow.id, profile: 'default', workspace: '', start_node_ids: ['only'],
        status: 'completed', snapshot_nodes: [node('only')], snapshot_edges: [],
      })
    }

    await expect(new WorkflowManager().delete(workflow.id)).resolves.toBe(true)
    expect(getWorkflow(workflow.id)).toBeNull()
    const remaining = state.db!.prepare('SELECT COUNT(*) AS count FROM workflow_runs WHERE workflow_id=?').get(workflow.id) as any
    expect(Number(remaining.count)).toBe(0)
  })

  it('persists skipped join:any evidence without creating sessions or spending budget', async () => {
    const requests: any[] = []
    state.runAndWait.mockImplementation(async (request: any) => {
      requests.push(request)
      return { ok: true, output: currentTask(request) }
    })
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const { listWorkflowRunNodeExecutions } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const merge = node('merge')
    merge.data = { ...merge.data, orchestration: { joinMode: 'any' } } as any
    const never = { route: 'success', condition: { path: 'output', operator: 'equals', value: 'never' } }
    const workflow = createWorkflow({
      name: 'join any skipped evidence',
      nodes: [node('header'), node('left'), node('right'), merge, node('publish')],
      edges: [
        edge('header-left', 'header', 'left'), edge('header-right', 'header', 'right'),
        edge('left-merge', 'left', 'merge', never), edge('right-merge', 'right', 'merge', never),
        feedback('merge-retry', 'merge', 'header', 2), edge('merge-publish', 'merge', 'publish'),
      ],
    })

    const result = await new WorkflowManager().runNow(workflow.id, { executionBudget: 3 })
    const executions = listWorkflowRunNodeExecutions(result.run.id)

    expect(result.run).toMatchObject({ status: 'completed', execution_budget: 3, execution_count: 3 })
    expect(requests.map(currentTask).sort()).toEqual(['header', 'left', 'right'])
    expect(executions.filter(item => item.status === 'skipped').map(item => item.node_id)).toEqual(['merge', 'publish'])
    expect(executions.filter(item => item.status === 'skipped').every(item => item.session_id === null)).toBe(true)
  })


  it('executes disjoint loops independently and joins only their final outputs', async () => {
    const attempts = new Map<string, number>()
    const publishInputs: string[] = []
    state.runAndWait.mockImplementation(async (request: any) => {
      const task = currentTask(request)
      if (task === 'a-latch' || task === 'b-latch') {
        const attempt = (attempts.get(task) || 0) + 1
        attempts.set(task, attempt)
        return { ok: true, output: JSON.stringify({ branch: task[0], retry: attempt === 1, attempt }) }
      }
      if (task === 'publish') publishInputs.push(String(request.input))
      return { ok: true, output: `${task}-output` }
    })
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const { listWorkflowRunEdgeEvaluations, listWorkflowRunNodeExecutions } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const workflow = createWorkflow({
      name: 'disjoint loops',
      nodes: [node('root'), node('a-head'), node('a-latch'), node('b-head'), node('b-latch'), node('publish')],
      edges: [
        edge('root-a', 'root', 'a-head'), edge('a-forward', 'a-head', 'a-latch'),
        feedback('a-retry', 'a-latch', 'a-head', 2), edge('a-exit', 'a-latch', 'publish'),
        edge('root-b', 'root', 'b-head'), edge('b-forward', 'b-head', 'b-latch'),
        feedback('b-retry', 'b-latch', 'b-head', 2), edge('b-exit', 'b-latch', 'publish'),
      ],
    })

    const result = await new WorkflowManager().runNow(workflow.id)
    const executions = listWorkflowRunNodeExecutions(result.run.id)
    const evaluations = listWorkflowRunEdgeEvaluations(result.run.id)

    expect(result.run).toMatchObject({ status: 'completed', execution_count: 10 })
    expect(executions.filter(item => item.node_id === 'a-head').map(item => item.iteration_path)).toEqual([
      [{ loopId: 'loop:a-retry', iteration: 1 }], [{ loopId: 'loop:a-retry', iteration: 2 }],
    ])
    expect(executions.filter(item => item.node_id === 'b-head').map(item => item.iteration_path)).toEqual([
      [{ loopId: 'loop:b-retry', iteration: 1 }], [{ loopId: 'loop:b-retry', iteration: 2 }],
    ])
    expect(evaluations.filter(item => item.edge_id === 'a-exit').map(item => item.delivery_status)).toEqual(['suppressed', 'delivered'])
    expect(evaluations.filter(item => item.edge_id === 'b-exit').map(item => item.delivery_status)).toEqual(['suppressed', 'delivered'])
    expect(publishInputs).toHaveLength(1)
    expect(publishInputs[0]).toContain('"branch":"a","retry":false,"attempt":2')
    expect(publishInputs[0]).toContain('"branch":"b","retry":false,"attempt":2')
    expect(publishInputs[0]).not.toContain('"attempt":1')
  })


  it('holds a nested cross-loop exit until both inner and outer loops finally settle', async () => {
    let outerPass = 1
    const innerAttempts = new Map<number, number>()
    const publishInputs: string[] = []
    state.runAndWait.mockImplementation(async (request: any) => {
      const task = currentTask(request)
      if (task === 'inner-l') {
        const attempt = (innerAttempts.get(outerPass) || 0) + 1
        innerAttempts.set(outerPass, attempt)
        return { ok: true, output: JSON.stringify({ level: 'inner', retry: attempt === 1, outerPass, attempt }) }
      }
      if (task === 'outer-l') {
        const current = outerPass
        const retry = current === 1
        if (retry) outerPass += 1
        return { ok: true, output: JSON.stringify({ level: 'outer', retry, outerPass: current }) }
      }
      if (task === 'publish') publishInputs.push(String(request.input))
      return { ok: true, output: `${task}:${outerPass}` }
    })
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const { listWorkflowRunEdgeEvaluations } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    const { WorkflowManager } = await import('../../packages/server/src/services/workflow-manager')
    const workflow = createWorkflow({
      name: 'nested cross-loop exit barrier',
      nodes: [node('outer-h'), node('inner-h'), node('inner-l'), node('outer-l'), node('publish')],
      edges: [
        edge('outer-enter-inner', 'outer-h', 'inner-h'), edge('inner-forward', 'inner-h', 'inner-l'),
        feedback('inner-retry', 'inner-l', 'inner-h', 3), edge('inner-to-outer-latch', 'inner-l', 'outer-l'),
        feedback('outer-retry', 'outer-l', 'outer-h', 2), edge('outer-exit', 'outer-l', 'publish'),
        edge('cross-both-exit', 'inner-l', 'publish'),
      ],
    })

    const result = await new WorkflowManager().runNow(workflow.id)
    const evaluations = listWorkflowRunEdgeEvaluations(result.run.id)

    expect(result.run).toMatchObject({ status: 'completed', execution_count: 13 })
    expect(evaluations.filter(item => item.edge_id === 'cross-both-exit').map(item => item.delivery_status)).toEqual([
      'suppressed', 'suppressed', 'suppressed', 'delivered',
    ])
    expect(evaluations.filter(item => item.edge_id === 'outer-exit').map(item => item.delivery_status)).toEqual(['suppressed', 'delivered'])
    expect(publishInputs).toHaveLength(1)
    expect(publishInputs[0]).toContain('"level":"inner","retry":false,"outerPass":2,"attempt":2')
    expect(publishInputs[0]).toContain('"level":"outer","retry":false,"outerPass":2')
    expect(publishInputs[0]).not.toContain('"outerPass":1')
  })

})
