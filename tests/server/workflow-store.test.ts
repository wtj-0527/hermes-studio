import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const state = vi.hoisted(() => ({
  db: null as DatabaseSync | null,
  appHome: '',
}))

vi.mock('../../packages/server/src/db/index', () => ({
  getDb: () => state.db,
  jsonDelete: vi.fn(),
  jsonGet: vi.fn(),
  jsonGetAll: vi.fn(() => ({})),
  jsonSet: vi.fn(),
}))

vi.mock('../../packages/server/src/config', () => ({
  config: {
    appHome: state.appHome,
  },
}))

describe('workflow store', () => {
  let root: string

  beforeEach(async () => {
    vi.resetModules()
    root = mkdtempSync(join(tmpdir(), 'hermes-workflow-store-'))
    state.appHome = join(root, 'home')
    state.db = new DatabaseSync(join(root, 'workflow.db'))
    const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')
    initAllHermesTables()
  })

  afterEach(() => {
    state.db?.close()
    state.db = null
    rmSync(root, { recursive: true, force: true })
  })

  it('creates workflows with a profile-scoped default workspace', async () => {
    const { createWorkflow, getWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')

    const workflow = createWorkflow({
      name: 'Research flow',
      profile: 'research',
      nodes: [{ id: 'agent-1' }],
      edges: [],
      viewport: { x: 12, y: 24, zoom: 0.8 },
    })

    expect(workflow.profile).toBe('research')
    expect(workflow.workspace).toBe(join(state.appHome, 'workflow', 'research', workflow.id))
    expect(existsSync(workflow.workspace!)).toBe(true)
    expect(getWorkflow(workflow.id)).toMatchObject({
      id: workflow.id,
      name: 'Research flow',
      profile: 'research',
      nodes: [{ id: 'agent-1' }],
      viewport: { x: 12, y: 24, zoom: 0.8 },
    })
  })

  it('updates and deletes workflows', async () => {
    const { createWorkflow, deleteWorkflow, getWorkflow, listWorkflows, updateWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const workflow = createWorkflow({ name: 'Draft', profile: 'default' })

    const updated = updateWorkflow(workflow.id, {
      name: 'Updated',
      workspace: null,
      nodes: [{ id: 'agent-2' }],
      edges: [{ source: 'agent-1', target: 'agent-2' }],
      viewport: { x: -120, y: 88, zoom: 1.1 },
    })

    expect(updated).toMatchObject({
      id: workflow.id,
      name: 'Updated',
      nodes: [{ id: 'agent-2' }],
      edges: [{ source: 'agent-1', target: 'agent-2' }],
      viewport: { x: -120, y: 88, zoom: 1.1 },
    })
    expect(updated?.workspace).toBe(workflow.workspace)
    expect(listWorkflows('default').map(item => item.id)).toContain(workflow.id)
    expect(deleteWorkflow(workflow.id)).toBe(true)
    expect(getWorkflow(workflow.id)).toBeNull()
  })

  it('lists workflow runs by workflow ordered newest first', async () => {
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const { createWorkflowRun, listWorkflowRuns, updateWorkflowRun } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    const workflow = createWorkflow({ name: 'Runs', profile: 'default' })
    const other = createWorkflow({ name: 'Other', profile: 'default' })

    const first = createWorkflowRun({ workflow_id: workflow.id, status: 'running', started_at: 100 })
    await new Promise(resolve => setTimeout(resolve, 2))
    const second = createWorkflowRun({ workflow_id: workflow.id, status: 'queued', started_at: 200 })
    createWorkflowRun({ workflow_id: other.id, status: 'running' })
    updateWorkflowRun(first.id, { status: 'completed', finished_at: 300 })

    expect(listWorkflowRuns(workflow.id).map(run => run.id)).toEqual([second.id, first.id])
    expect(listWorkflowRuns(workflow.id, 1)).toHaveLength(1)
    expect(listWorkflowRuns(workflow.id)[1]).toMatchObject({
      id: first.id,
      status: 'completed',
      finished_at: 300,
    })
  })

  it('persists edge evaluations on run detail and list records', async () => {
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const {
      createWorkflowRun,
      createWorkflowRunEdgeResult,
      getWorkflowRun,
      listWorkflowRunEdgeResults,
      listWorkflowRuns,
    } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    const workflow = createWorkflow({ name: 'Conditional', profile: 'default' })
    const run = createWorkflowRun({ workflow_id: workflow.id, status: 'running' })

    const edgeResult = createWorkflowRunEdgeResult({
      run_id: run.id,
      workflow_id: workflow.id,
      edge_id: 'approve',
      source_node_id: 'plan',
      target_node_id: 'publish',
      status: 'taken',
      reason: 'condition matched',
      context: { status: 'success', json: { approved: true } },
    })

    expect(listWorkflowRunEdgeResults(run.id)).toEqual([edgeResult])
    expect(getWorkflowRun(run.id)?.edge_results).toEqual([edgeResult])
    expect(listWorkflowRuns(workflow.id)[0].edge_results).toEqual([edgeResult])
  })

  it('deletes workflow edge results together with their run', async () => {
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const {
      createWorkflowRun,
      createWorkflowRunEdgeResult,
      deleteWorkflowRun,
      listWorkflowRunEdgeResults,
    } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    const workflow = createWorkflow({ name: 'Cleanup', profile: 'default' })
    const run = createWorkflowRun({ workflow_id: workflow.id, status: 'completed' })
    createWorkflowRunEdgeResult({
      run_id: run.id,
      workflow_id: workflow.id,
      edge_id: 'e1',
      source_node_id: 'a',
      target_node_id: 'b',
      status: 'not_taken',
      reason: 'condition did not match',
      context: { status: 'success' },
    })

    expect(deleteWorkflowRun(run.id)).toBe(true)
    expect(listWorkflowRunEdgeResults(run.id)).toEqual([])
  })

  it('deletes workflow runs and their node session records', async () => {
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const {
      createWorkflowRun,
      createWorkflowRunNodeSession,
      deleteWorkflowRun,
      getWorkflowRun,
      listWorkflowRunNodeSessions,
    } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    const workflow = createWorkflow({ name: 'Runs', profile: 'default' })
    const run = createWorkflowRun({ workflow_id: workflow.id, status: 'completed' })
    createWorkflowRunNodeSession({
      run_id: run.id,
      workflow_id: workflow.id,
      node_id: 'node-1',
      session_id: 'session-1',
      status: 'completed',
    })

    expect(listWorkflowRunNodeSessions(run.id)).toHaveLength(1)
    expect(deleteWorkflowRun(run.id)).toBe(true)

    expect(getWorkflowRun(run.id)).toBeNull()
    expect(listWorkflowRunNodeSessions(run.id)).toEqual([])
  })
  it('persists durable run node states in detail and list records', async () => {
    const { createWorkflow } = await import('../../packages/server/src/db/hermes/workflow-store')
    const { createWorkflowRun, updateWorkflowRunNodeState, getWorkflowRun, listWorkflowRuns } = await import('../../packages/server/src/db/hermes/workflow-run-store')
    const workflow = createWorkflow({ name: 'States' })
    const run = createWorkflowRun({ workflow_id: workflow.id })
    updateWorkflowRunNodeState(run.id, 'skipped-node', { status: 'skipped', reason: 'branch not taken', started_at: 10, finished_at: 10 })
    expect(getWorkflowRun(run.id)?.node_states).toEqual({ 'skipped-node': { status: 'skipped', reason: 'branch not taken', started_at: 10, finished_at: 10 } })
    expect(listWorkflowRuns(workflow.id)[0].node_states).toEqual(getWorkflowRun(run.id)?.node_states)
  })

  it('additively migrates legacy workflow runs without losing data', async () => {
    const db = state.db!
    db.exec(`
      DROP TABLE workflow_runs;
      CREATE TABLE workflow_runs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        profile TEXT NOT NULL DEFAULT 'default',
        workspace TEXT,
        start_node_ids_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'queued',
        snapshot_nodes_json TEXT NOT NULL DEFAULT '[]',
        snapshot_edges_json TEXT NOT NULL DEFAULT '[]',
        started_at INTEGER,
        finished_at INTEGER,
        created_at INTEGER NOT NULL,
        error TEXT
      );
    `)
    const nodes = [{ id: 'legacy-node', data: { title: 'Legacy' } }]
    const edges = [{ id: 'legacy-edge', source: 'legacy-node', target: 'next' }]
    db.prepare(`INSERT INTO workflow_runs (
      id, workflow_id, profile, workspace, start_node_ids_json, status,
      snapshot_nodes_json, snapshot_edges_json, started_at, finished_at, created_at, error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('legacy-run', 'legacy-workflow', 'default', '/legacy/workspace', '["legacy-node"]', 'failed', JSON.stringify(nodes), JSON.stringify(edges), 10, 20, 5, 'legacy error')

    const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')
    initAllHermesTables()
    const { getWorkflowRun, updateWorkflowRunNodeState } = await import('../../packages/server/src/db/hermes/workflow-run-store')

    const columns = db.prepare('PRAGMA table_info(workflow_runs)').all() as Array<{ name: string }>
    expect(columns.map(column => column.name)).toContain('node_states_json')
    expect(db.prepare('SELECT COUNT(*) AS count FROM workflow_runs WHERE id = ?').get('legacy-run')).toEqual({ count: 1 })

    const migrated = getWorkflowRun('legacy-run')
    expect(migrated).toMatchObject({
      id: 'legacy-run', workflow_id: 'legacy-workflow', profile: 'default', workspace: '/legacy/workspace',
      start_node_ids: ['legacy-node'], status: 'failed', snapshot_nodes: nodes, snapshot_edges: edges,
      started_at: 10, finished_at: 20, created_at: 5, error: 'legacy error', node_states: {},
    })

    updateWorkflowRunNodeState('legacy-run', 'next', { status: 'skipped', reason: 'legacy branch not taken', started_at: 30, finished_at: 30 })
    expect(getWorkflowRun('legacy-run')?.node_states).toEqual({
      next: { status: 'skipped', reason: 'legacy branch not taken', started_at: 30, finished_at: 30 },
    })

    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workflow_run_edge_results'").get()).toEqual({ name: 'workflow_run_edge_results' })
    const indexes = db.prepare('PRAGMA index_list(workflow_run_edge_results)').all() as Array<{ name: string; unique: number }>
    expect(indexes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'uniq_workflow_run_edge_results_run_edge', unique: 1 }),
    ]))
  })

})
