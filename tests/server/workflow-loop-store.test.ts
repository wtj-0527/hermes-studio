import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const state = vi.hoisted(() => ({ db: null as DatabaseSync | null, appHome: '' }))
vi.mock('../../packages/server/src/db/index', () => ({
  getDb: () => state.db,
  jsonDelete: vi.fn(), jsonGet: vi.fn(), jsonGetAll: vi.fn(() => ({})), jsonSet: vi.fn(),
}))
vi.mock('../../packages/server/src/config', () => ({ config: { appHome: state.appHome } }))

const outer1 = [{ loopId: 'loop:outer', iteration: 1 }]
const outer2 = [{ loopId: 'loop:outer', iteration: 2 }]
const nested = [
  { loopId: 'loop:outer', iteration: 2 },
  { loopId: 'loop:inner', iteration: 1 },
]

describe('workflow v2 loop evidence store', () => {
  let root: string
  beforeEach(async () => {
    vi.resetModules()
    root = mkdtempSync(join(tmpdir(), 'workflow-loop-store-'))
    state.appHome = join(root, 'home')
    state.db = new DatabaseSync(join(root, 'workflow.db'))
    const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')
    initAllHermesTables()
  })
  afterEach(() => {
    state.db?.close(); state.db = null
    rmSync(root, { recursive: true, force: true })
  })

  async function createV2Run(budget = 10) {
    const { createWorkflowRun } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    return createWorkflowRun({
      workflow_id: 'workflow-1', status: 'running', orchestration_version: 2,
      compiled_plan: { loops: [{ id: 'loop:outer' }] }, deadline_at: Date.now() + 60_000,
      execution_budget: budget,
    })
  }

  it('creates additive v2 tables and run metadata without replacing legacy tables', async () => {
    const run = await createV2Run(7)
    expect(run).toMatchObject({
      orchestration_version: 2, compiled_plan: { loops: [{ id: 'loop:outer' }] },
      execution_budget: 7, execution_count: 0, terminal_code: null,
    })
    const names = (state.db!.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(row => row.name)
    expect(names).toEqual(expect.arrayContaining([
      'workflow_runs', 'workflow_run_node_sessions', 'workflow_run_edge_results',
      'workflow_run_node_executions', 'workflow_run_edge_evaluations', 'workflow_run_loop_iterations',
    ]))
  })

  it('roundtrips canonical ordered iteration paths and rejects malformed paths', async () => {
    const { canonicalIterationPath, parseIterationPath } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    const canonical = canonicalIterationPath(nested)
    expect(canonical).toBe('[{"loopId":"loop:outer","iteration":2},{"loopId":"loop:inner","iteration":1}]')
    expect(parseIterationPath(canonical)).toEqual(nested)
    for (const invalid of [
      null, {}, [{ loopId: '', iteration: 1 }], [{ loopId: '__proto__', iteration: 1 }],
      [{ loopId: 'loop:x', iteration: 0 }], [{ loopId: 'loop:x', iteration: 1.5 }],
      [{ loopId: 'loop:x', iteration: 1 }, { loopId: 'loop:x', iteration: 2 }],
    ]) {
      expect(() => canonicalIterationPath(invalid as any)).toThrow(/iteration path/i)
    }
  })

  it('stores repeated node executions append-only by node and iteration path', async () => {
    const run = await createV2Run()
    const {
      reserveWorkflowNodeExecution, listWorkflowRunNodeExecutions,
    } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    const first = reserveWorkflowNodeExecution({
      run_id: run.id, workflow_id: run.workflow_id, node_id: 'agent', session_id: 'session-1',
      profile: 'default', agent: 'hermes', agent_mode: '', iteration_path: outer1, sequence: 1,
    })
    const second = reserveWorkflowNodeExecution({
      run_id: run.id, workflow_id: run.workflow_id, node_id: 'agent', session_id: 'session-2',
      profile: 'default', agent: 'hermes', agent_mode: '', iteration_path: outer2, sequence: 2,
    })
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(listWorkflowRunNodeExecutions(run.id).map(item => ({
      node: item.node_id, session: item.session_id, path: item.iteration_path,
    }))).toEqual([
      { node: 'agent', session: 'session-1', path: outer1 },
      { node: 'agent', session: 'session-2', path: outer2 },
    ])
    expect(() => reserveWorkflowNodeExecution({
      run_id: run.id, workflow_id: run.workflow_id, node_id: 'agent', session_id: 'duplicate',
      profile: 'default', agent: 'hermes', agent_mode: '', iteration_path: outer2, sequence: 3,
    })).toThrow(/execution.*iteration path|unique/i)
  })

  it('reserves execution budget atomically and skipped evidence does not consume it', async () => {
    const run = await createV2Run(2)
    const {
      createSkippedWorkflowNodeExecution, getWorkflowRun, listWorkflowRunNodeExecutions,
      reserveWorkflowNodeExecution,
    } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    createSkippedWorkflowNodeExecution({
      run_id: run.id, workflow_id: run.workflow_id, node_id: 'skipped', iteration_path: outer1,
      profile: 'default', agent: 'hermes', agent_mode: '', sequence: 1, reason: 'branch not taken',
    })
    for (const [index, path] of [outer1, outer2].entries()) {
      expect(reserveWorkflowNodeExecution({
        run_id: run.id, workflow_id: run.workflow_id, node_id: 'real', session_id: `session-${index}`,
        profile: 'default', agent: 'hermes', agent_mode: '', iteration_path: path, sequence: index + 2,
      }).ok).toBe(true)
    }
    const exhausted = reserveWorkflowNodeExecution({
      run_id: run.id, workflow_id: run.workflow_id, node_id: 'third', session_id: 'session-third',
      profile: 'default', agent: 'hermes', agent_mode: '', iteration_path: outer1, sequence: 4,
    })
    expect(exhausted).toEqual({ ok: false, code: 'node_execution_budget_exceeded' })
    expect(getWorkflowRun(run.id)?.execution_count).toBe(2)
    expect(listWorkflowRunNodeExecutions(run.id)).toHaveLength(3)
    expect(listWorkflowRunNodeExecutions(run.id)[0]).toMatchObject({
      node_id: 'skipped', session_id: null, status: 'skipped', reason: 'branch not taken',
    })
  })

  it('appends repeated edge evaluations and loop iterations without overwriting history', async () => {
    const run = await createV2Run()
    const {
      createWorkflowEdgeEvaluation, createWorkflowLoopIteration,
      listWorkflowRunEdgeEvaluations, listWorkflowRunLoopIterations, updateWorkflowEdgeEvaluation, updateWorkflowLoopIteration,
    } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    for (const [index, path] of [outer1, outer2].entries()) {
      const evaluation = createWorkflowEdgeEvaluation({
        run_id: run.id, workflow_id: run.workflow_id, source_execution_id: `execution-${index}`,
        edge_id: 'retry', source_node_id: 'latch', target_node_id: 'header', iteration_path: path,
        loop_id: 'loop:outer', status: index === 0 ? 'taken' : 'not_taken',
        delivery_status: index === 0 ? 'suppressed' : 'delivered', reason: 'condition', context: {}, sequence: index + 1,
      })
      if (index === 0) updateWorkflowEdgeEvaluation(evaluation.id, { consumed_by_execution_id: 'consumer-1' })
      const iteration = createWorkflowLoopIteration({
        run_id: run.id, workflow_id: run.workflow_id, loop_id: 'loop:outer', iteration_path: path,
        iteration: index + 1, status: 'running', sequence: index + 1,
      })
      updateWorkflowLoopIteration(iteration.id, {
        status: index === 0 ? 'retrying' : 'completed', feedback_evaluation_id: `edge-${index}`, finished_at: 100 + index,
      })
    }
    expect(listWorkflowRunEdgeEvaluations(run.id).map(item => ({ path: item.iteration_path, status: item.status }))).toEqual([
      { path: outer1, status: 'taken' }, { path: outer2, status: 'not_taken' },
    ])
    expect(listWorkflowRunLoopIterations(run.id).map(item => ({ path: item.iteration_path, status: item.status }))).toEqual([
      { path: outer1, status: 'retrying' }, { path: outer2, status: 'completed' },
    ])
    expect(listWorkflowRunEdgeEvaluations(run.id).map(item => item.consumed_by_execution_id)).toEqual(['consumer-1', null])
  })

  it('deletes every v2 evidence row with its run while legacy rows remain readable', async () => {
    const run = await createV2Run()
    const store = await import('../../packages/server/src/db/hermes/workflow-run-store')
    store.createSkippedWorkflowNodeExecution({
      run_id: run.id, workflow_id: run.workflow_id, node_id: 'a', iteration_path: nested,
      profile: 'default', agent: 'hermes', agent_mode: '', sequence: 1, reason: 'skip',
    })
    store.createWorkflowEdgeEvaluation({
      run_id: run.id, workflow_id: run.workflow_id, source_execution_id: null, edge_id: 'e',
      source_node_id: 'a', target_node_id: 'b', iteration_path: nested, loop_id: null,
      status: 'not_taken', delivery_status: 'suppressed', reason: 'skip', context: {}, sequence: 1,
    })
    store.createWorkflowLoopIteration({
      run_id: run.id, workflow_id: run.workflow_id, loop_id: 'loop:inner', iteration_path: nested,
      iteration: 1, status: 'completed', sequence: 1,
    })
    expect(store.deleteWorkflowRun(run.id)).toBe(true)
    expect(store.listWorkflowRunNodeExecutions(run.id)).toEqual([])
    expect(store.listWorkflowRunEdgeEvaluations(run.id)).toEqual([])
    expect(store.listWorkflowRunLoopIterations(run.id)).toEqual([])

    state.db!.prepare(`INSERT INTO workflow_runs (
      id, workflow_id, profile, workspace, start_node_ids_json, status, snapshot_nodes_json,
      snapshot_edges_json, node_states_json, started_at, finished_at, created_at, error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('legacy-run', 'legacy-workflow', 'default', null, '[]', 'completed', '[]', '[]', '{}', 1, 2, 1, null)
    expect(store.getWorkflowRun('legacy-run')).toMatchObject({
      orchestration_version: 1, execution_budget: 0, execution_count: 0, terminal_code: null,
    })
  })
})
